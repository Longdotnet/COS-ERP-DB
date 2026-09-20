import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../../main/config.js';
import { resolvePath } from '../../main/sandbox.js';
import type {
  DatabaseFieldConsumersResult,
  DatabaseIncidentSourceEvidence,
  DatabaseSourceTraceKind,
  DatabaseSourceTraceMatch,
  DatabaseSourceTraceResult
} from './types.js';

const MAX_FILES = 6_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 48_000_000;
const MAX_MATCHES = 300;
const MAX_PREVIEW_CHARS = 360;

const SOURCE_EXTENSIONS = new Set(['.cs', '.vb', '.resx', '.sql', '.config', '.xml']);
const SKIP_DIRECTORIES = new Set([
  '.git', '.vs', '.idea', 'bin', 'obj', 'node_modules', 'packages', 'dist', 'out', 'coverage'
]);

interface SourceTraceTerms {
  field: string;
  table: string;
  consumers: string[];
}

export async function traceApplicationObjectTerms(
  sourceRoot: string,
  terms: { procedures?: string[]; table?: string | null }
): Promise<DatabaseIncidentSourceEvidence> {
  const startedAt = Date.now();
  const requestedRoot = sourceRoot.trim();
  if (!requestedRoot || requestedRoot.length > 4096) throw new Error('Source root must contain 1 to 4096 characters.');
  const resolved = await resolvePath(getConfig().roots, requestedRoot);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new Error('Source root must be an approved folder.');
  const scanned = await scanSourceTraceRoot(resolved.real, resolved.virtual, {
    field: '__cos_incident_unmatched_field__',
    table: terms.table?.trim() ?? '',
    consumers: (terms.procedures ?? []).map(value => value.trim()).filter(Boolean).slice(0, 20)
  });
  return {
    sourceRoot: resolved.virtual,
    ...scanned,
    elapsedMs: Date.now() - startedAt
  };
}

function normalizedPreview(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ');
  return compact.length <= MAX_PREVIEW_CHARS ? compact : `${compact.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}

function classifyLine(line: string, matchedTerm: string, terms: SourceTraceTerms): { kind: DatabaseSourceTraceKind; confidence: 'high' | 'medium' } {
  const lower = line.toLowerCase();
  const field = terms.field.toLowerCase();
  const term = matchedTerm.toLowerCase();
  const bindingEvidence = /datapropertyname|databindings|bindingsource|displaymember|valuemember|datamember|field<|\[["']/.test(lower);
  if (term === field && bindingEvidence) return { kind: 'winforms-binding', confidence: 'high' };
  if (terms.consumers.some(value => value.toLowerCase() === term)) return { kind: 'sql-call', confidence: 'high' };
  if (term === field) return { kind: 'field-reference', confidence: 'medium' };
  return { kind: 'table-reference', confidence: 'medium' };
}

function termsFor(flow: DatabaseFieldConsumersResult): SourceTraceTerms {
  return {
    field: flow.source.column,
    table: flow.source.table,
    consumers: flow.consumers.map(item => item.name).filter(Boolean).slice(0, 40)
  };
}

function termPriority(term: string, terms: SourceTraceTerms): number {
  if (term.toLowerCase() === terms.field.toLowerCase()) return 0;
  if (terms.consumers.some(value => value.toLowerCase() === term.toLowerCase())) return 1;
  return 2;
}

/**
 * Bounded application-source scan used by the Database Investigator.
 * `realRoot` has already passed the app's approved-root sandbox. Symlinks/junctions are skipped
 * instead of followed so the scan cannot escape that authorization after the initial resolve.
 */
export async function scanSourceTraceRoot(
  realRoot: string,
  virtualRoot: string,
  terms: SourceTraceTerms
): Promise<{ searchedFiles: number; skippedFiles: number; matches: DatabaseSourceTraceMatch[]; truncated: boolean; limitations: string[] }> {
  const queue = [realRoot];
  const matches: DatabaseSourceTraceMatch[] = [];
  let searchedFiles = 0;
  let skippedFiles = 0;
  let totalBytes = 0;
  let truncated = false;
  const candidates = [terms.field, ...terms.consumers, terms.table]
    .map(value => value.trim())
    .filter((value, index, values) => value && values.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index)
    .sort((a, b) => termPriority(a, terms) - termPriority(b, terms));

  while (queue.length && searchedFiles < MAX_FILES && totalBytes < MAX_TOTAL_BYTES && matches.length < MAX_MATCHES) {
    const directory = queue.shift()!;
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }
    for (const entry of entries) {
      if (searchedFiles >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES || matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) {
        skippedFiles += 1;
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        skippedFiles += 1;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
        skippedFiles += 1;
        if (totalBytes + stat.size > MAX_TOTAL_BYTES) truncated = true;
        continue;
      }
      searchedFiles += 1;
      totalBytes += stat.size;
      let text: string;
      try {
        text = await fs.readFile(fullPath, 'utf8');
      } catch {
        skippedFiles += 1;
        continue;
      }
      if (text.includes('\u0000')) {
        skippedFiles += 1;
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < MAX_MATCHES; index += 1) {
        const line = lines[index]!;
        const lower = line.toLowerCase();
        const matchedTerm = candidates.find(term => lower.includes(term.toLowerCase()));
        if (!matchedTerm) continue;
        const classified = classifyLine(line, matchedTerm, terms);
        const relative = path.relative(realRoot, fullPath).split(path.sep).join('/');
        matches.push({
          path: relative ? `${virtualRoot.replace(/\/$/, '')}/${relative}` : virtualRoot,
          line: index + 1,
          kind: classified.kind,
          matchedTerm,
          preview: normalizedPreview(line),
          confidence: classified.confidence
        });
      }
    }
  }
  if (queue.length || searchedFiles >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES || matches.length >= MAX_MATCHES) truncated = true;
  const limitations = [
    'Source trace is text evidence, not a compiler/runtime call graph. Reflection, generated code and values assembled dynamically can be missed.',
    `The scan is bounded to ${MAX_FILES.toLocaleString('en-US')} source files, ${Math.round(MAX_TOTAL_BYTES / 1_000_000)} MB of text and ${MAX_MATCHES} returned matches.`,
    'bin, obj, package/cache folders and filesystem links are skipped.'
  ];
  return { searchedFiles, skippedFiles, matches, truncated, limitations };
}

export async function traceApplicationSource(
  connection: string,
  database: string,
  flow: DatabaseFieldConsumersResult,
  sourceRoot: string
): Promise<DatabaseSourceTraceResult> {
  const startedAt = Date.now();
  const requestedRoot = sourceRoot.trim();
  if (!requestedRoot || requestedRoot.length > 4096) throw new Error('Source root must contain 1 to 4096 characters.');
  const resolved = await resolvePath(getConfig().roots, requestedRoot);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new Error('Source root must be an approved folder.');
  const scanned = await scanSourceTraceRoot(resolved.real, resolved.virtual, termsFor(flow));
  return {
    connection,
    database,
    source: flow.source,
    sourceRoot: resolved.virtual,
    ...scanned,
    elapsedMs: Date.now() - startedAt
  };
}
