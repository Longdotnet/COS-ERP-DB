import { promises as fs } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { extractDocument, knowledgeDocumentStaticLimitations } from '../src/cos-erp-db/knowledge/document-text.js';
import { databaseOriginFingerprint } from '../src/cos-erp-db/knowledge/index-database.js';
import {
  getKnowledgeEvidence,
  indexKnowledge,
  resetKnowledgeSearchCacheForTests,
  searchKnowledge,
  verifyKnowledgeEvidence
} from '../src/cos-erp-db/knowledge/service.js';
import {
  initKnowledgeStore,
  mutateKnowledgeScope,
  readKnowledgeScope,
  resetKnowledgeStoreForTests
} from '../src/cos-erp-db/knowledge/store.js';
import type { Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let workspace = '';
let roots: Root[] = [];

beforeEach(async () => {
  directory = await makeTempDir('cos-knowledge-');
  workspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
  roots = [{ name: 'workspace', path: workspace }];
  initKnowledgeStore(path.join(directory, 'user-data'));
  resetKnowledgeSearchCacheForTests();
});

afterEach(async () => {
  resetKnowledgeSearchCacheForTests();
  resetKnowledgeStoreForTests();
  await removeTempDir(directory);
});

it('indexes source and solution documents, searches narrowly, and detects stale evidence', async () => {
  const sourcePath = path.join(workspace, 'src', 'PayrollRule.cs');
  const documentPath = path.join(workspace, 'docs', 'payroll-solution.md');
  await fs.writeFile(sourcePath, [
    'public static class PayrollRule {',
    '  public const string RuleName = "NetSalaryAdjustment";',
    '}'
  ].join('\n'), 'utf8');
  await fs.writeFile(documentPath, [
    '# Payroll solution',
    'Net salary is reduced by approved employee adjustments before finalization.'
  ].join('\n'), 'utf8');

  const indexed = await indexKnowledge({
    scope: 'linkq-payroll',
    sources: [
      { kind: 'source', path: '/workspace/src' },
      { kind: 'document', path: '/workspace/docs/payroll-solution.md' }
    ]
  }, roots);

  expect(indexed.counts.evidence).toBeGreaterThanOrEqual(2);
  expect(indexed.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'source', sourceKey: 'source:/workspace/src' }),
    expect.objectContaining({ kind: 'document', sourceKey: 'document:/workspace/docs/payroll-solution.md' })
  ]));

  const search = await searchKnowledge({ scope: 'linkq-payroll', query: 'NetSalaryAdjustment' });
  expect(search.hits[0]).toMatchObject({
    kind: 'source',
    locator: { path: '/workspace/src/PayrollRule.cs' }
  });
  const evidenceId = search.hits[0]!.evidenceId;
  const fetched = await getKnowledgeEvidence('linkq-payroll', [evidenceId]);
  expect(fetched.evidence[0]?.content).toContain('NetSalaryAdjustment');

  const current = await verifyKnowledgeEvidence({
    scope: 'linkq-payroll',
    evidence: [{ evidenceId, contentHash: search.hits[0]!.contentHash }]
  }, roots);
  expect(current.allCurrent).toBe(true);
  expect(current.evidence[0]?.status).toBe('current');

  await fs.appendFile(sourcePath, '\n// changed after indexing\n', 'utf8');
  const stale = await verifyKnowledgeEvidence({
    scope: 'linkq-payroll',
    evidence: [{ evidenceId, contentHash: search.hits[0]!.contentHash }]
  }, roots);
  expect(stale.allCurrent).toBe(false);
  expect(stale.evidence[0]?.status).toBe('stale');
});

it('extracts bounded DOCX text without requiring a separate Office parser', async () => {
  const file = path.join(workspace, 'docs', 'solution.docx');
  const archive = zipSync({
    'word/document.xml': strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Recruitment approval rule</w:t></w:r></w:p></w:body></w:document>'
    ),
    'word/styles.xml': strToU8('<styles>ignored</styles>')
  });
  await fs.writeFile(file, archive);

  const extracted = await extractDocument(file);
  expect(extracted.parts).toHaveLength(1);
  expect(extracted.parts[0]?.text).toContain('Recruitment approval rule');
  expect(extracted.sourceHash).toMatch(/^[a-f0-9]{64}$/);
});

it('binds database evidence to non-secret connection origin', () => {
  const base = databaseOriginFingerprint('linkq', {
    server: 'sql-a',
    database: 'L80LINKQ.TEST',
    authentication: { type: 'sql', user: 'sa', password: 'secret-a' }
  });
  const sameOriginDifferentPassword = databaseOriginFingerprint('LINKQ', {
    server: 'SQL-A',
    database: 'l80linkq.test',
    authentication: { type: 'sql', user: 'other', password: 'secret-b' }
  });
  const differentServer = databaseOriginFingerprint('linkq', {
    server: 'sql-b',
    database: 'L80LINKQ.TEST',
    authentication: { type: 'sql', user: 'sa', password: 'secret-a' }
  });

  expect(base).toBe(sameOriginDifferentPassword);
  expect(base).not.toBe(differentServer);
});

it('refresh replaces the scope while incremental indexing preserves other source roots', async () => {
  await fs.writeFile(path.join(workspace, 'src', 'A.cs'), 'class AlphaKnowledge {}', 'utf8');
  await fs.writeFile(path.join(workspace, 'docs', 'B.md'), 'Beta requirement', 'utf8');

  await indexKnowledge({
    scope: 'scope-refresh',
    sources: [{ kind: 'source', path: '/workspace/src' }]
  }, roots);
  await indexKnowledge({
    scope: 'scope-refresh',
    sources: [{ kind: 'document', path: '/workspace/docs/B.md' }],
    mode: 'incremental'
  }, roots);
  expect((await searchKnowledge({ scope: 'scope-refresh', query: 'AlphaKnowledge' })).hits).toHaveLength(1);
  expect((await searchKnowledge({ scope: 'scope-refresh', query: 'Beta requirement' })).hits).toHaveLength(1);

  await indexKnowledge({
    scope: 'scope-refresh',
    sources: [{ kind: 'document', path: '/workspace/docs/B.md' }],
    mode: 'refresh'
  }, roots);
  expect((await searchKnowledge({ scope: 'scope-refresh', query: 'AlphaKnowledge' })).hits).toHaveLength(0);
  expect((await searchKnowledge({ scope: 'scope-refresh', query: 'Beta requirement' })).hits).toHaveLength(1);
});

it('reuses unchanged source evidence without rereading or rehashing files', async () => {
  const sourcePath = path.join(workspace, 'src', 'Reuse.cs');
  await fs.writeFile(sourcePath, 'class ReusedKnowledge {}', 'utf8');

  const first = await indexKnowledge({
    scope: 'scope-reuse',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });
  const second = await indexKnowledge({
    scope: 'scope-reuse',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });

  expect(first.telemetry).toMatchObject({ filesRead: 1, filesReused: 0, sourceHashesComputed: 1 });
  expect(second.generation).toBe(first.generation);
  expect(second.counts).toMatchObject({ added: 0, updated: 0, removed: 0 });
  expect(second.telemetry).toMatchObject({ filesRead: 0, filesReused: 1, sourceHashesComputed: 0, sourceBytesProcessed: 0 });
  const afterFirst = await readKnowledgeScope('scope-reuse');
  const updatedAt = afterFirst.updatedAt;
  await indexKnowledge({
    scope: 'scope-reuse',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });
  expect((await readKnowledgeScope('scope-reuse')).updatedAt).toBe(updatedAt);
});

it('rehashes when content changes even if size and mtime are restored', async () => {
  const sourcePath = path.join(workspace, 'src', 'Fence.cs');
  await fs.writeFile(sourcePath, 'class Fence { int Value = 1; }', 'utf8');
  const first = await indexKnowledge({
    scope: 'scope-fence',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });
  const before = await fs.stat(sourcePath);

  await fs.writeFile(sourcePath, 'class Fence { int Value = 2; }', 'utf8');
  await fs.utimes(sourcePath, before.atime, before.mtime);
  const second = await indexKnowledge({
    scope: 'scope-fence',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });

  expect(second.telemetry).toMatchObject({ filesRead: 1, filesReused: 0, sourceHashesComputed: 1 });
  expect(second.generation).not.toBe(first.generation);
  expect((await searchKnowledge({ scope: 'scope-fence', query: 'Value = 2' })).hits).toHaveLength(1);
});

it('reuses unchanged children while removing deleted files and indexing new files', async () => {
  const a = path.join(workspace, 'src', 'A.cs');
  const b = path.join(workspace, 'src', 'B.cs');
  const c = path.join(workspace, 'src', 'C.cs');
  await fs.writeFile(a, 'class IncrementalA {}', 'utf8');
  await fs.writeFile(b, 'class IncrementalB {}', 'utf8');
  await indexKnowledge({
    scope: 'scope-children',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });

  await fs.unlink(b);
  await fs.writeFile(c, 'class IncrementalC {}', 'utf8');
  const updated = await indexKnowledge({
    scope: 'scope-children',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });

  expect(updated.counts).toMatchObject({ added: 1, removed: 1 });
  expect(updated.telemetry).toMatchObject({ filesRead: 1, filesReused: 1, sourceHashesComputed: 1 });
  expect((await searchKnowledge({ scope: 'scope-children', query: 'IncrementalB' })).hits).toHaveLength(0);
  expect((await searchKnowledge({ scope: 'scope-children', query: 'IncrementalC' })).hits).toHaveLength(1);
});

it('rehashes legacy evidence without ctime once before it can be reused', async () => {
  const file = path.join(workspace, 'src', 'Legacy.cs');
  await fs.writeFile(file, 'class LegacyKnowledge {}', 'utf8');
  await indexKnowledge({
    scope: 'scope-legacy',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });
  await mutateKnowledgeScope('scope-legacy', current => ({
    ...current,
    evidence: current.evidence.map(item => {
      const { sourceCtimeMs: _sourceCtimeMs, ...legacy } = item;
      return legacy;
    })
  }));

  const refreshed = await indexKnowledge({
    scope: 'scope-legacy',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });
  const reused = await indexKnowledge({
    scope: 'scope-legacy',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, roots, { reuseUnchangedFiles: true });

  expect(refreshed.telemetry).toMatchObject({ filesRead: 1, filesReused: 0, sourceHashesComputed: 1 });
  expect(reused.telemetry).toMatchObject({ filesRead: 0, filesReused: 1, sourceHashesComputed: 0 });
});

it('keeps deterministic PDF limitations available on a reuse path', () => {
  expect(knowledgeDocumentStaticLimitations('/workspace/docs/scanned.pdf')).toContain(
    'PDF indexing extracts embedded text only; image-only/scanned pages require OCR outside this indexer.'
  );
  expect(knowledgeDocumentStaticLimitations('/workspace/docs/requirements.docx')).toEqual([]);
});
