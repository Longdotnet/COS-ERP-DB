import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import type { KnowledgeEvidence } from './contracts/knowledge.js';
import { walkFiles } from '../../main/codex/read-backend.js';
import { DEFAULT_EXCLUDES } from '../../main/search.js';
import { resolvePath } from '../../main/sandbox.js';
import { chunkKnowledgeText, createKnowledgeEvidence, knowledgeSha256 } from './evidence.js';
import {
  extractDocument,
  KNOWLEDGE_DOCUMENT_EXTENSIONS,
  knowledgeDocumentStaticLimitations
} from './document-text.js';

const MAX_SOURCE_FILES = 6_000;
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const SOURCE_INDEX_CONCURRENCY = 4;
const KNOWLEDGE_SOURCE_EXCLUDES = [...DEFAULT_EXCLUDES, 'bin', 'obj'];

export interface IndexedKnowledgeSource {
  kind: 'source' | 'document';
  sourceKey: string;
  evidence: KnowledgeEvidence[];
  limitations: string[];
  telemetry: {
    filesDiscovered: number;
    filesProcessed: number;
    filesRead: number;
    filesReused: number;
    sourceBytesProcessed: number;
    sourceHashesComputed: number;
    documentsExtracted: number;
  };
}

function reusableEvidence(
  previous: readonly KnowledgeEvidence[],
  stat: { size: number; mtimeMs: number; ctimeMs: number }
): KnowledgeEvidence[] | null {
  if (!previous.length) return null;
  if (!previous.every(item =>
    item.sourceSize === stat.size
    && item.sourceMtimeMs === stat.mtimeMs
    && item.sourceCtimeMs === stat.ctimeMs)) return null;
  return [...previous];
}

const SOURCE_EXTENSIONS = new Set([
  '.cs', '.vb', '.fs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql', '.ps1', '.sh', '.py', '.go', '.java', '.kt', '.kts',
  '.resx', '.config', '.xml', '.json', '.jsonc', '.yaml', '.yml',
  '.csproj', '.fsproj', '.vbproj', '.sln', '.props', '.targets',
  '.md', '.mdx', '.txt', '.html', '.htm', '.css', '.scss'
]);

function isEligible(kind: 'source' | 'document', file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return kind === 'source' ? SOURCE_EXTENSIONS.has(extension) : KNOWLEDGE_DOCUMENT_EXTENSIONS.has(extension);
}

function virtualChild(rootVirtual: string, fileVirtual: string): string {
  if (fileVirtual === rootVirtual) return '';
  const prefix = rootVirtual.endsWith('/') ? rootVirtual : `${rootVirtual}/`;
  return fileVirtual.startsWith(prefix) ? fileVirtual.slice(prefix.length) : fileVirtual;
}

function realChild(rootReal: string, rootVirtual: string, fileVirtual: string): string {
  const relative = virtualChild(rootVirtual, fileVirtual);
  return relative ? path.join(rootReal, ...relative.split('/')) : rootReal;
}

async function indexSourceFile(input: {
  scope: string;
  sourceKey: string;
  virtualPath: string;
  realPath: string;
  capturedAt: string;
  previousEvidence: readonly KnowledgeEvidence[];
}): Promise<{ evidence: KnowledgeEvidence[]; bytes: number; readBytes: number; hashed: boolean; reused: boolean; limitation?: string }> {
  const stat = await fs.stat(input.realPath);
  if (!stat.isFile()) return { evidence: [], bytes: 0, readBytes: 0, hashed: false, reused: false, limitation: `${input.virtualPath}: not a regular file.` };
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    return {
      evidence: [],
      bytes: 0,
      readBytes: 0,
      hashed: false,
      reused: false,
      limitation: `${input.virtualPath}: skipped because it is larger than ${MAX_SOURCE_FILE_BYTES} bytes.`
    };
  }
  const reused = reusableEvidence(input.previousEvidence, stat);
  if (reused) return { evidence: reused, bytes: stat.size, readBytes: 0, hashed: false, reused: true };
  const buffer = await fs.readFile(input.realPath);
  const text = buffer.toString('utf8');
  if (text.includes('\u0000')) return { evidence: [], bytes: stat.size, readBytes: buffer.length, hashed: false, reused: false, limitation: `${input.virtualPath}: binary content skipped.` };
  const sourceHash = knowledgeSha256(buffer);
  const evidence = chunkKnowledgeText(text).map(chunk => createKnowledgeEvidence({
    scope: input.scope,
    kind: 'source',
    sourceKey: input.sourceKey,
    title: path.basename(input.virtualPath),
    content: chunk.content,
    sourceHash,
    capturedAt: input.capturedAt,
    locator: {
      path: input.virtualPath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd
    },
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    sourceCtimeMs: stat.ctimeMs
  }));
  return { evidence, bytes: stat.size, readBytes: buffer.length, hashed: true, reused: false };
}

async function indexDocumentFile(input: {
  scope: string;
  sourceKey: string;
  virtualPath: string;
  realPath: string;
  capturedAt: string;
  previousEvidence: readonly KnowledgeEvidence[];
}): Promise<{ evidence: KnowledgeEvidence[]; bytes: number; readBytes: number; hashed: boolean; reused: boolean; limitations: string[] }> {
  const stat = await fs.stat(input.realPath);
  const reused = reusableEvidence(input.previousEvidence, stat);
  if (reused) {
    return {
      evidence: reused,
      bytes: stat.size,
      readBytes: 0,
      hashed: false,
      reused: true,
      limitations: knowledgeDocumentStaticLimitations(input.realPath).map(value => `${input.virtualPath}: ${value}`)
    };
  }
  const document = await extractDocument(input.realPath);
  const evidence: KnowledgeEvidence[] = [];
  for (const part of document.parts) {
    for (const chunk of chunkKnowledgeText(part.text)) {
      evidence.push(createKnowledgeEvidence({
        scope: input.scope,
        kind: 'document',
        sourceKey: input.sourceKey,
        title: part.part ? `${path.basename(input.virtualPath)} — ${part.part}` : path.basename(input.virtualPath),
        content: chunk.content,
        sourceHash: document.sourceHash,
        capturedAt: input.capturedAt,
        locator: {
          path: input.virtualPath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          ...(part.page === null ? {} : { page: part.page }),
          ...(part.part === null ? {} : { part: part.part })
        },
        sourceSize: document.sourceSize,
        sourceMtimeMs: document.sourceMtimeMs,
        sourceCtimeMs: stat.ctimeMs
      }));
    }
  }
  return {
    evidence,
    bytes: document.sourceSize,
    readBytes: document.sourceSize,
    hashed: true,
    reused: false,
    limitations: document.limitations.map(value => `${input.virtualPath}: ${value}`)
  };
}

export async function indexKnowledgePath(
  scope: string,
  kind: 'source' | 'document',
  requestedPath: string,
  roots: readonly Root[],
  previousEvidence: readonly KnowledgeEvidence[] = []
): Promise<IndexedKnowledgeSource> {
  const capturedAt = new Date().toISOString();
  const requested = requestedPath.trim();
  if (!requested || requested.length > 4096) throw new Error('Knowledge source path must contain 1 to 4096 characters.');
  const resolved = await resolvePath(roots, requested);
  const stat = await fs.stat(resolved.real);
  const sourceKey = `${kind}:${resolved.virtual}`;
  const previousByPath = new Map<string, KnowledgeEvidence[]>();
  for (const item of previousEvidence) {
    if (item.kind !== kind || item.sourceKey !== sourceKey || !item.locator.path) continue;
    const list = previousByPath.get(item.locator.path) ?? [];
    list.push(item);
    previousByPath.set(item.locator.path, list);
  }
  let files: string[];
  let walkTruncated = false;
  if (stat.isFile()) {
    if (!isEligible(kind, resolved.virtual)) {
      throw new Error(`Unsupported ${kind} file type: ${path.extname(resolved.virtual) || '(no extension)'}`);
    }
    files = [resolved.virtual];
  } else if (stat.isDirectory()) {
    const walked = await walkFiles(resolved.real, resolved.virtual, {
      maxEntries: MAX_SOURCE_FILES,
      exclude: KNOWLEDGE_SOURCE_EXCLUDES
    });
    files = walked.files.filter(file => isEligible(kind, file));
    walkTruncated = walked.truncated;
  } else {
    throw new Error('Knowledge source path must be a file or folder.');
  }

  const evidence: KnowledgeEvidence[] = [];
  const limitations: string[] = [];
  const telemetry = {
    filesDiscovered: files.length,
    filesProcessed: 0,
    filesRead: 0,
    filesReused: 0,
    sourceBytesProcessed: 0,
    sourceHashesComputed: 0,
    documentsExtracted: 0
  };
  let totalBytes = 0;
  let processed = 0;
  if (kind === 'source') {
    let cursor = 0;
    let stoppedForBudget = false;
    while (cursor < files.length
      && processed < MAX_SOURCE_FILES
      && totalBytes < MAX_TOTAL_SOURCE_BYTES
      && !stoppedForBudget) {
      const remainingBytes = MAX_TOTAL_SOURCE_BYTES - totalBytes;
      const budgetWaveSize = Math.max(1, Math.floor(remainingBytes / MAX_SOURCE_FILE_BYTES));
      const waveSize = Math.min(SOURCE_INDEX_CONCURRENCY, files.length - cursor, budgetWaveSize);
      const wavePaths = files.slice(cursor, cursor + waveSize);
      const indexedBatch = await Promise.all(wavePaths.map(async virtualPath => {
        const realPath = stat.isFile() ? resolved.real : realChild(resolved.real, resolved.virtual, virtualPath);
        try {
          const indexed = await indexSourceFile({
            scope, sourceKey, virtualPath, realPath, capturedAt,
            previousEvidence: previousByPath.get(virtualPath) ?? []
          });
          return { virtualPath, indexed, error: null as unknown };
        } catch (error) {
          return { virtualPath, indexed: null, error };
        }
      }));
      for (const result of indexedBatch) {
        if (!result.indexed) {
          if (stat.isFile()) throw result.error;
          limitations.push(`${result.virtualPath}: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
          continue;
        }
        const indexed = result.indexed;
        if (totalBytes + indexed.bytes > MAX_TOTAL_SOURCE_BYTES) {
          limitations.push(`Stopped before ${result.virtualPath}: source byte budget reached.`);
          stoppedForBudget = true;
          break;
        }
        totalBytes += indexed.bytes;
        if (indexed.readBytes > 0) telemetry.filesRead++;
        if (indexed.reused) telemetry.filesReused++;
        telemetry.sourceBytesProcessed += indexed.readBytes;
        if (indexed.hashed) telemetry.sourceHashesComputed++;
        evidence.push(...indexed.evidence);
        if (indexed.limitation) limitations.push(indexed.limitation);
        processed += 1;
        telemetry.filesProcessed++;
      }
      cursor += wavePaths.length;
    }
  } else {
    for (const virtualPath of files) {
      if (processed >= MAX_SOURCE_FILES || totalBytes >= MAX_TOTAL_SOURCE_BYTES) break;
      const realPath = stat.isFile() ? resolved.real : realChild(resolved.real, resolved.virtual, virtualPath);
      try {
        const indexed = await indexDocumentFile({
          scope, sourceKey, virtualPath, realPath, capturedAt,
          previousEvidence: previousByPath.get(virtualPath) ?? []
        });
        if (totalBytes + indexed.bytes > MAX_TOTAL_SOURCE_BYTES) {
          limitations.push(`Stopped before ${virtualPath}: document byte budget reached.`);
          break;
        }
        totalBytes += indexed.bytes;
        if (indexed.readBytes > 0) telemetry.filesRead++;
        if (indexed.reused) telemetry.filesReused++;
        telemetry.sourceBytesProcessed += indexed.readBytes;
        if (indexed.hashed) telemetry.sourceHashesComputed++;
        if (!indexed.reused) telemetry.documentsExtracted++;
        evidence.push(...indexed.evidence);
        limitations.push(...indexed.limitations);
        processed += 1;
        telemetry.filesProcessed++;
      } catch (error) {
        if (stat.isFile()) throw error;
        limitations.push(`${virtualPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (walkTruncated || processed < files.length) {
    limitations.push(
      `Index is bounded to ${MAX_SOURCE_FILES.toLocaleString('en-US')} files and ${Math.round(MAX_TOTAL_SOURCE_BYTES / 1024 / 1024)} MiB of source data per source root.`
    );
  }
  if (!files.length) limitations.push(`No supported ${kind} files were found under ${resolved.virtual}.`);
  return { kind, sourceKey, evidence, limitations, telemetry };
}
