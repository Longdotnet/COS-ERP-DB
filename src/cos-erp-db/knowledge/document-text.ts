import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_OFFICE_EXPANDED_BYTES = 48 * 1024 * 1024;

export interface ExtractedDocumentPart {
  part: string | null;
  page: number | null;
  text: string;
}

export interface ExtractedDocument {
  parts: ExtractedDocumentPart[];
  limitations: string[];
  sourceHash: string;
  sourceSize: number;
  sourceMtimeMs: number;
}

const PLAIN_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.csv', '.json', '.jsonc', '.yaml', '.yml', '.xml', '.html', '.htm'
]);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xmlBodyText(xml: string, paragraphClose: RegExp, tabOrBreak: RegExp): string {
  return cleanText(decodeXml(
    xml
      .replace(paragraphClose, '\n')
      .replace(tabOrBreak, '\t')
      .replace(/<[^>]+>/g, '')
  ));
}

function archiveText(files: Record<string, Uint8Array>, name: string): string | null {
  const value = files[name];
  return value ? Buffer.from(value).toString('utf8') : null;
}

function relevantOfficeEntry(extension: '.docx' | '.pptx' | '.xlsx', name: string): boolean {
  if (extension === '.docx') return /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name);
  if (extension === '.pptx') return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
  return name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name);
}

function unzipOfficeDocument(buffer: Buffer, extension: '.docx' | '.pptx' | '.xlsx'): Record<string, Uint8Array> {
  let expandedBytes = 0;
  const files = unzipSync(buffer, {
    filter: file => {
      if (!relevantOfficeEntry(extension, file.name)) return false;
      if (file.originalSize > MAX_OFFICE_ENTRY_BYTES) {
        throw new Error(`Office document entry is too large to index safely: ${file.name}`);
      }
      expandedBytes += file.originalSize;
      if (expandedBytes > MAX_OFFICE_EXPANDED_BYTES) {
        throw new Error('Office document expands beyond the knowledge indexing safety limit.');
      }
      return true;
    }
  });
  const actualBytes = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
  if (actualBytes > MAX_OFFICE_EXPANDED_BYTES) {
    throw new Error('Office document expands beyond the knowledge indexing safety limit.');
  }
  return files;
}

function extractDocx(files: Record<string, Uint8Array>): ExtractedDocumentPart[] {
  const names = Object.keys(files)
    .filter(name => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  const parts: ExtractedDocumentPart[] = [];
  for (const name of names) {
    const xml = archiveText(files, name);
    if (!xml) continue;
    const text = xmlBodyText(xml, /<\/w:p>/gi, /<w:(?:tab|br)(?:\s[^>]*)?\/?\s*>/gi);
    if (text) parts.push({ part: name === 'word/document.xml' ? 'document' : name, page: null, text });
  }
  return parts;
}

function xmlTextNodes(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
    values.push(cleanText(decodeXml(match[1] ?? '')));
  }
  return values;
}

function extractPptx(files: Record<string, Uint8Array>): ExtractedDocumentPart[] {
  const names = Object.keys(files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const left = Number(a.match(/slide(\d+)/i)?.[1] ?? 0);
      const right = Number(b.match(/slide(\d+)/i)?.[1] ?? 0);
      return left - right;
    });
  return names.flatMap((name, index) => {
    const xml = archiveText(files, name);
    if (!xml) return [];
    const text = xmlBodyText(xml, /<\/a:p>/gi, /<a:(?:br|tab)(?:\s[^>]*)?\/?\s*>/gi);
    return text ? [{ part: `slide ${index + 1}`, page: index + 1, text }] : [];
  });
}

function cellValue(body: string, type: string | null, shared: readonly string[]): string {
  if (type === 'inlineStr') return xmlTextNodes(body).join('');
  const value = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1];
  if (value === undefined) return xmlTextNodes(body).join('');
  const decoded = decodeXml(value);
  if (type === 's') {
    const index = Number.parseInt(decoded, 10);
    return Number.isInteger(index) && shared[index] !== undefined ? shared[index]! : decoded;
  }
  return decoded;
}

function extractXlsx(files: Record<string, Uint8Array>): ExtractedDocumentPart[] {
  const sharedXml = archiveText(files, 'xl/sharedStrings.xml');
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)].map(match => xmlTextNodes(match[1] ?? '').join(''))
    : [];
  const names = Object.keys(files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const left = Number(a.match(/sheet(\d+)/i)?.[1] ?? 0);
      const right = Number(b.match(/sheet(\d+)/i)?.[1] ?? 0);
      return left - right;
    });
  const parts: ExtractedDocumentPart[] = [];
  for (const [sheetIndex, name] of names.entries()) {
    const xml = archiveText(files, name);
    if (!xml) continue;
    const lines: string[] = [];
    for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gi)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attributes = cell[1] ?? '';
        const reference = attributes.match(/\br="([^"]+)"/i)?.[1] ?? '';
        const type = attributes.match(/\bt="([^"]+)"/i)?.[1] ?? null;
        const value = cleanText(cellValue(cell[2] ?? '', type, shared));
        if (value) cells.push(reference ? `${reference}=${value}` : value);
      }
      if (cells.length) lines.push(cells.join('\t'));
    }
    const text = cleanText(lines.join('\n'));
    if (text) parts.push({ part: `sheet ${sheetIndex + 1}`, page: null, text });
  }
  return parts;
}

async function extractPdf(buffer: Buffer): Promise<ExtractedDocumentPart[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false
  });
  const document = await loading.promise;
  const parts: ExtractedDocumentPart[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = cleanText(content.items
        .map(item => 'str' in item && typeof item.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' '));
      if (text) parts.push({ part: `page ${pageNumber}`, page: pageNumber, text });
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
  return parts;
}

export async function extractDocument(realPath: string): Promise<ExtractedDocument> {
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error('Knowledge document source must be a file.');
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document is too large to index safely (${stat.size} bytes; maximum ${MAX_DOCUMENT_BYTES}).`);
  }
  const buffer = await fs.readFile(realPath);
  const extension = path.extname(realPath).toLowerCase();
  const limitations = knowledgeDocumentStaticLimitations(realPath);
  let parts: ExtractedDocumentPart[];
  if (PLAIN_EXTENSIONS.has(extension)) {
    const text = buffer.toString('utf8');
    if (text.includes('\u0000')) throw new Error('Document appears to be binary but has a text extension.');
    parts = cleanText(text) ? [{ part: null, page: null, text: cleanText(text) }] : [];
  } else if (extension === '.pdf') {
    parts = await extractPdf(buffer);
  } else if (extension === '.docx' || extension === '.pptx' || extension === '.xlsx') {
    const files = unzipOfficeDocument(buffer, extension);
    parts = extension === '.docx' ? extractDocx(files) : extension === '.pptx' ? extractPptx(files) : extractXlsx(files);
  } else {
    throw new Error(`Unsupported knowledge document type: ${extension || '(no extension)'}`);
  }
  return {
    parts,
    limitations,
    sourceHash: sha256(buffer),
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs
  };
}

export function knowledgeDocumentStaticLimitations(pathname: string): string[] {
  return path.extname(pathname).toLowerCase() === '.pdf'
    ? ['PDF indexing extracts embedded text only; image-only/scanned pages require OCR outside this indexer.']
    : [];
}

export const KNOWLEDGE_DOCUMENT_EXTENSIONS = new Set([
  ...PLAIN_EXTENSIONS,
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx'
]);
