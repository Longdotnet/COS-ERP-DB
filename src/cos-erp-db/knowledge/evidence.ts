import { createHash } from 'node:crypto';
import type {
  KnowledgeEvidence,
  KnowledgeEvidenceKind,
  KnowledgeEvidenceLocator
} from './contracts/knowledge.js';

const MAX_CHUNK_LINES = 80;
const MAX_CHUNK_CHARS = 8_000;

export interface TextChunk {
  content: string;
  lineStart: number;
  lineEnd: number;
}

export function knowledgeSha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function chunkKnowledgeText(text: string): TextChunk[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let start = 1;

  const flush = (end: number): void => {
    const content = current.join('\n').trim();
    if (content) chunks.push({ content, lineStart: start, lineEnd: Math.max(start, end) });
    current = [];
    currentChars = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? '';
    const pieces = raw.length <= MAX_CHUNK_CHARS
      ? [raw]
      : Array.from({ length: Math.ceil(raw.length / MAX_CHUNK_CHARS) }, (_, part) =>
          raw.slice(part * MAX_CHUNK_CHARS, (part + 1) * MAX_CHUNK_CHARS));
    for (const piece of pieces) {
      const extra = (current.length ? 1 : 0) + piece.length;
      if (current.length && (current.length >= MAX_CHUNK_LINES || currentChars + extra > MAX_CHUNK_CHARS)) {
        flush(lineNumber - 1);
        start = lineNumber;
      }
      if (!current.length) start = lineNumber;
      current.push(piece);
      currentChars += (current.length > 1 ? 1 : 0) + piece.length;
      if (current.length >= MAX_CHUNK_LINES || currentChars >= MAX_CHUNK_CHARS) {
        flush(lineNumber);
        start = lineNumber + 1;
      }
    }
  }
  if (current.length) flush(lines.length);
  return chunks;
}

function evidenceIdentity(
  scope: string,
  kind: KnowledgeEvidenceKind,
  sourceKey: string,
  locator: KnowledgeEvidenceLocator
): string {
  return knowledgeSha256(`${scope}\u0000${kind}\u0000${sourceKey}\u0000${JSON.stringify(locator)}`);
}

export function createKnowledgeEvidence(input: {
  scope: string;
  kind: KnowledgeEvidenceKind;
  sourceKey: string;
  title: string;
  content: string;
  sourceHash: string;
  capturedAt: string;
  locator: KnowledgeEvidenceLocator;
  sourceSize?: number | null;
  sourceMtimeMs?: number | null;
  sourceCtimeMs?: number | null;
}): KnowledgeEvidence {
  return {
    id: evidenceIdentity(input.scope, input.kind, input.sourceKey, input.locator),
    scope: input.scope,
    kind: input.kind,
    sourceKey: input.sourceKey,
    title: input.title,
    content: input.content,
    contentHash: knowledgeSha256(input.content),
    sourceHash: input.sourceHash,
    capturedAt: input.capturedAt,
    locator: input.locator,
    sourceSize: input.sourceSize ?? null,
    sourceMtimeMs: input.sourceMtimeMs ?? null,
    sourceCtimeMs: input.sourceCtimeMs ?? null
  };
}
