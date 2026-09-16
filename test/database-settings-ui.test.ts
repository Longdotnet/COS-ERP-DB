import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import type { DatabaseSettingsState } from '../src/shared/database.js';

let dom: JSDOM;
let state: DatabaseSettingsState;
let api: Record<string, ReturnType<typeof vi.fn>>;

const reply = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), {
    url: 'http://localhost',
    pretendToBeVisual: true
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);

  state = {
    settings: {
      defaultConnectionId: 'linkq-test',
      connections: [{
        id: 'linkq-test',
        name: 'LinkQ Test',
        provider: 'sqlserver',
        accessMode: 'read-only',
        server: 'linkqwin.linkq.vn',
        database: 'L80LINKQ.TEST',
        port: 2027,
        encrypt: false,
        trustServerCertificate: true,
        authentication: { type: 'sql', user: 'long' }
      }]
    },
    passwordStored: { 'linkq-test': true },
    secureStorage: { available: true, detail: null }
  };
  api = {
    getDatabaseState: vi.fn(() => reply(state)),
    writeClipboard: vi.fn((_text: string) => reply(true)),
    saveDatabaseProfile: vi.fn(),
    removeDatabaseProfile: vi.fn(),
    setDatabasePassword: vi.fn(),
    testDatabaseConnection: vi.fn(),
    readDatabaseGrowthDiagnostics: vi.fn(() => reply({
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-15T17:00:00.000Z',
      summary: { totalMb: 2038.75, dataMb: 238.75, logMb: 1800, dataUsedMb: 173.13, logUsedMb: 1783.98, logUsedPercent: 99.11, tableCount: 250 },
      log: { available: true, stateAvailable: true, recoveryModel: 'FULL', reuseWait: 'LOG_BACKUP', totalMb: 1800, usedMb: 1783.98, freeMb: 16.02, usedPercent: 99.11, sinceLastBackupMb: 1783 },
      files: [],
      largestTables: [{ objectId: 42, schema: 'dbo', name: 'L00ZONES', rows: 1000, reservedMb: 150, usedMb: 140, dataMb: 130, indexMb: 10 }],
      tableStorageAvailable: true,
      findings: [{
        id: 'log-backup-wait', severity: 'high', title: 'Log reuse is waiting for a log backup',
        detail: 'Recovery model is FULL.', nextAction: 'Inspect the SQL Server Agent backup job.'
      }],
      nextActions: ['Inspect the SQL Server Agent backup job.', 'Capture a dated baseline.'],
      limitations: [],
      historicalBaselineAvailable: false,
      elapsedMs: 7
    })),
    readDatabaseGrowthCapture: vi.fn(() => reply({
      captureVersion: 2,
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-15T17:00:00.000Z',
      summary: { totalMb: 2038.75, dataMb: 238.75, logMb: 1800, dataUsedMb: 173.13, logUsedMb: 1783.98, logUsedPercent: 99.11, tableCount: 250 },
      files: [],
      tables: [{ objectId: 42, schema: 'dbo', name: 'L00ZONES', rows: 1000, reservedMb: 150, usedMb: 140, dataMb: 130, indexMb: 10 }],
      tablesTruncated: false,
      limitations: []
    })),
    compareDatabaseGrowth: vi.fn((request: { baselineConnection: string; currentConnection: string; baselineAsOf?: string }) => reply({
      baseline: { connection: request.baselineConnection, database: 'L80LINKQ_2025', capturedAt: '2026-09-16T01:00:00.000Z', ...(request.baselineAsOf ? { asOf: request.baselineAsOf } : {}), tablesTruncated: false },
      current: { connection: request.currentConnection, database: 'L80LINKQ.TEST', capturedAt: '2026-09-16T01:00:01.000Z', tablesTruncated: false },
      summary: {
        totalAllocatedDeltaMb: 20480,
        dataAllocatedDeltaMb: 17408,
        dataUsedDeltaMb: 14800,
        logAllocatedDeltaMb: 3072,
        logUsedDeltaMb: 400,
        tableUsedDeltaMb: 11755,
        unattributedDataUsedDeltaMb: 3045,
        attributionPercent: 79.43,
        tableCountDelta: 23
      },
      fileDeltas: [{ name: 'ERP', type: 'data', state: 'matched', baselineSizeMb: 4096, currentSizeMb: 21504, sizeDeltaMb: 17408, baselineUsedMb: 3800, currentUsedMb: 18600, usedDeltaMb: 14800 }],
      tableDeltas: [{
        schema: 'dbo', name: 'L01BANKHISTORY', state: 'matched', baselineObjectId: 10, currentObjectId: 900,
        baselineRows: 1000000, currentRows: 40000000, rowDelta: 39000000,
        baselineReservedMb: 800, currentReservedMb: 8500, reservedDeltaMb: 7700,
        baselineUsedMb: 750, currentUsedMb: 8200, usedDeltaMb: 7450,
        baselineDataMb: 700, currentDataMb: 7100, dataDeltaMb: 6400,
        baselineIndexMb: 50, currentIndexMb: 1100, indexDeltaMb: 1050
      }],
      totalTableDifferenceCount: 1,
      returnedTableDifferenceCount: 1,
      omittedTableDifferenceCount: 0,
      limitations: []
    })),
    readDatabaseGrowthHistory: vi.fn(() => reply({ connection: 'linkq-test', snapshots: [] })),
    saveDatabaseGrowthSnapshot: vi.fn((_id: string, snapshot: unknown) => reply({
      connection: 'linkq-test',
      snapshots: [{ id: '11111111-1111-4111-8111-111111111111', connection: 'linkq-test', savedAt: '2026-09-15T17:01:00.000Z', ...(snapshot as object) }]
    })),
    searchDatabaseObjects: vi.fn(() => reply({ objects: [], hasMore: false, elapsedMs: 1 })),
    readDatabaseTablePage: vi.fn(() => reply({
      schema: 'dbo',
      table: 'L00ZONES',
      columns: [{ name: 'Zone', type: 'varchar', nullable: false, primaryKeyOrdinal: 1 }],
      rows: [{ Zone: 'A' }],
      hasMore: false,
      elapsedMs: 1,
      pagingMode: 'keyset'
    })),
    updateDatabaseTableCell: vi.fn(() => reply({ affectedRows: 1, elapsedMs: 5 })),
    readDatabaseObjectDetails: vi.fn((request: { section: string }) => reply({
      schema: 'dbo',
      name: 'L00ZONES',
      type: 'table',
      section: request.section,
      ...(request.section === 'columns' ? {
        columns: [{ ordinal: 1, name: 'Zone', type: 'varchar(50)', nullable: false, identity: false, computed: false, defaultDefinition: null, computedDefinition: null }]
      } : {}),
      ...(request.section === 'keys_indexes' ? { indexes: [], foreignKeys: [] } : {}),
      ...(request.section === 'ddl' ? { ddl: { text: 'CREATE TABLE [dbo].[L00ZONES] ([Zone] varchar(50) NOT NULL);', kind: 'generated-table', complete: false } } : {}),
      ...(request.section === 'dependencies' ? { outboundDependencies: [], inboundDependencies: [] } : {}),
      elapsedMs: 2
    })),
    setDatabaseWorkspaceContext: vi.fn((context: unknown) => reply(context))
  };
  Object.assign(dom.window, { api });
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('keeps saved SQL Server connections visible while creating a new one', async () => {
  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const saved = document.querySelector<HTMLButtonElement>('.database-profile-card[data-profile-id="linkq-test"]')!;
  expect(saved).toBeTruthy();
  expect(saved.textContent).toContain('LinkQ Test');
  expect(saved.textContent).toContain('linkqwin.linkq.vn,2027 · L80LINKQ.TEST');
  expect(saved.textContent).toContain('Default');
  expect(saved.textContent).toContain('Read-only');
  expect(saved.textContent).toContain('Password saved');
  expect(saved.getAttribute('aria-pressed')).toBe('true');
  expect(saved.querySelector('.database-profile-badge.is-default')).toBeTruthy();
  expect(saved.querySelector('.database-profile-badge.is-read-only')).toBeTruthy();

  document.getElementById('databaseAdd')!.click();

  const cards = [...document.querySelectorAll<HTMLButtonElement>('.database-profile-card')];
  expect(cards).toHaveLength(2);
  expect(cards[0]!.textContent).toContain('New SQL Server connection');
  expect(cards[0]!.textContent).toContain('Not saved yet');
  expect(cards[0]!.classList.contains('is-draft')).toBe(true);
  expect(cards[1]!.textContent).toContain('LinkQ Test');
  expect(document.getElementById('databaseEditorTitle')!.textContent).toBe('New SQL Server connection');
  expect((document.getElementById('databaseName') as HTMLInputElement).value).toBe('');
  expect((document.getElementById('databaseEncrypt') as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById('databaseTrustServerCertificate') as HTMLInputElement).checked).toBe(false);
  expect((document.getElementById('databaseAccessMode') as HTMLSelectElement).value).toBe('read-only');

  cards[1]!.click();
  expect(document.getElementById('databaseEditorTitle')!.textContent).toBe('LinkQ Test');
  expect((document.getElementById('databaseServer') as HTMLInputElement).value).toBe('linkqwin.linkq.vn');
  expect((document.getElementById('databasePort') as HTMLInputElement).value).toBe('2027');
  expect((document.getElementById('databaseEncrypt') as HTMLInputElement).checked).toBe(false);
  expect((document.getElementById('databaseTrustServerCertificate') as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById('databaseAccessMode') as HTMLSelectElement).value).toBe('read-only');
});

it('renders growth investigation as a readable dashboard and drills a table into Object Explorer', async () => {
  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();
  await tick();

  expect(api.readDatabaseGrowthDiagnostics).not.toHaveBeenCalled();
  expect(document.querySelector('.database-growth-state')!.textContent).toContain('Run an investigation');
  document.getElementById('databaseGrowthRefresh')!.click();
  await tick();

  expect(api.readDatabaseGrowthDiagnostics).toHaveBeenCalledWith('linkq-test');
  expect(api.readDatabaseGrowthHistory).toHaveBeenCalledWith('linkq-test');
  expect(document.querySelector('.database-growth-metrics')!.textContent).toContain('1.99 GB');
  expect(document.querySelector('.database-growth-metrics')!.textContent).toContain('99.1%');
  expect(document.querySelector('.database-growth-findings')!.textContent).toContain('Log reuse is waiting for a log backup');
  expect(document.querySelector('.database-growth-log-health')!.textContent).toContain('LOG_BACKUP');
  expect(document.querySelector('.database-growth-actions')!.textContent).toContain('Capture a dated baseline');

  let aiPrompt = '';
  let aiAutoSend = false;
  dom.window.addEventListener('cos:database-open-chat', (event) => {
    const detail = (event as CustomEvent<{ suggestedText?: string; autoSend?: boolean }>).detail;
    aiPrompt = detail?.suggestedText ?? '';
    aiAutoSend = detail?.autoSend === true;
  });
  document.getElementById('databaseGrowthExplain')!.click();
  expect(aiPrompt).toContain('L80LINKQ.TEST');
  expect(aiPrompt).toContain('LOG_BACKUP');
  expect(aiPrompt).toContain('Do not claim historical growth');
  expect(aiAutoSend).toBe(true);

  document.getElementById('databaseGrowthSaveSnapshot')!.click();
  await tick();
  expect(api.readDatabaseGrowthCapture).toHaveBeenCalledWith('linkq-test');
  expect(api.saveDatabaseGrowthSnapshot).toHaveBeenCalledWith('linkq-test', expect.objectContaining({
    captureVersion: 2,
    database: 'L80LINKQ.TEST',
    capturedAt: '2026-09-15T17:00:00.000Z'
  }));
  expect(document.querySelector('.database-growth-history')!.textContent).toContain('1 snapshot');

  const table = document.querySelector<HTMLButtonElement>('.database-growth-table-link')!;
  expect(table.textContent).toBe('dbo.L00ZONES');
  table.click();
  await tick();

  expect(document.querySelector('.database-object-workspace-identity')!.textContent).toContain('dbo.L00ZONES');
  expect(api.readDatabaseTablePage).toHaveBeenLastCalledWith({ connection: 'linkq-test', objectId: 42, limit: 100 });
});

it('compares a restored baseline database with the current database and sends measured evidence to AI', async () => {
  state.settings.connections.unshift({
    id: 'linkq-2025',
    name: 'LinkQ Backup 2025',
    provider: 'sqlserver',
    accessMode: 'read-only',
    server: 'localhost',
    database: 'L80LINKQ_2025',
    encrypt: false,
    trustServerCertificate: true,
    authentication: { type: 'sql', user: 'long' }
  });

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();
  await tick();

  const baseline = document.getElementById('databaseGrowthCompareBaseline') as HTMLSelectElement;
  const current = document.getElementById('databaseGrowthCompareCurrent') as HTMLSelectElement;
  const baselineDate = document.getElementById('databaseGrowthCompareBaselineDate') as HTMLInputElement;
  baseline.value = 'linkq-2025';
  current.value = 'linkq-test';
  baselineDate.value = '2025-09-16';
  document.getElementById('databaseGrowthCompareRun')!.click();
  await tick();

  expect(api.compareDatabaseGrowth).toHaveBeenCalledWith({
    baselineConnection: 'linkq-2025',
    currentConnection: 'linkq-test',
    baselineAsOf: '2025-09-16'
  });
  const comparison = document.getElementById('databaseGrowthCompareBody')!;
  expect(comparison.textContent).toContain('+20.0 GB');
  expect(comparison.textContent).toContain('79.4%');
  expect(comparison.textContent).toContain('dbo.L01BANKHISTORY');
  expect(comparison.textContent).toContain('+39,000,000');

  let aiPrompt = '';
  dom.window.addEventListener('cos:database-open-chat', event => {
    aiPrompt = (event as CustomEvent<{ suggestedText?: string }>).detail?.suggestedText ?? '';
  });
  document.getElementById('databaseGrowthCompareExplain')!.click();
  expect(aiPrompt).toContain('2025-09-16');
  expect(aiPrompt).toContain('data actually used');
  expect(aiPrompt).toContain('L01BANKHISTORY');
  expect(aiPrompt).toContain('Do not claim a historical cause');
});

it('shows an explicit unsaved connection on first use', async () => {
  state = {
    settings: { connections: [] },
    passwordStored: {},
    secureStorage: { available: true, detail: null }
  };
  api.getDatabaseState!.mockImplementation(() => reply(state));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const card = document.querySelector<HTMLButtonElement>('.database-profile-card.is-draft')!;
  expect(card).toBeTruthy();
  expect(card.textContent).toContain('New SQL Server connection');
  expect(card.textContent).toContain('Not saved yet');
  expect((document.getElementById('databaseDefault') as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById('databaseEncrypt') as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById('databaseTrustServerCertificate') as HTMLInputElement).checked).toBe(false);
  expect((document.getElementById('databaseAccessMode') as HTMLSelectElement).value).toBe('read-only');
});

it('persists Full access while explaining that only guarded Object Explorer edits are enabled', async () => {
  api.saveDatabaseProfile!.mockImplementation((draft: unknown) => reply({ state, profileId: 'linkq-test', draft }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const access = document.getElementById('databaseAccessMode') as HTMLSelectElement;
  access.value = 'full-access';
  access.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(document.getElementById('databaseAccessModeHint')!.textContent).toContain('guarded inline cell editing');
  expect(document.getElementById('databaseAccessModeHint')!.textContent).toContain('queries remain read-only');

  document.getElementById('databaseSave')!.click();
  await tick();

  expect(api.saveDatabaseProfile).toHaveBeenCalledWith(expect.objectContaining({ accessMode: 'full-access' }), undefined);
});

it('lazy-loads and pages Object Explorer groups instead of loading the whole catalog', async () => {
  api.searchDatabaseObjects!.mockImplementation((request: { cursor?: string }) => request.cursor
    ? reply({
        objects: [{ schema: 'dbo', name: 'L01SecondPage', type: 'table', objectId: 2, modifiedAt: null }],
        hasMore: false,
        elapsedMs: 3
      })
    : reply({
        objects: [{ schema: 'dbo', name: 'L00ZONES', type: 'table', objectId: 1, modifiedAt: null }],
        hasMore: true,
        nextCursor: 'cursor-2',
        elapsedMs: 2
      }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  expect(api.searchDatabaseObjects).not.toHaveBeenCalled();
  const tables = document.querySelector<HTMLDetailsElement>('.database-object-group[data-object-type="table"]')!;
  tables.open = true;
  tables.dispatchEvent(new dom.window.Event('toggle'));
  await tick();

  expect(api.searchDatabaseObjects).toHaveBeenCalledWith({
    connection: 'linkq-test',
    types: ['table'],
    limit: 50
  });
  expect(document.getElementById('databaseObjects-table')!.textContent).toContain('L00ZONES');
  expect(document.getElementById('databaseObjectsCount-table')!.textContent).toBe('1+');

  document.getElementById('databaseObjectsMore-table')!.click();
  await tick();

  expect(api.searchDatabaseObjects).toHaveBeenLastCalledWith({
    connection: 'linkq-test',
    types: ['table'],
    limit: 50,
    cursor: 'cursor-2'
  });
  expect(document.getElementById('databaseObjects-table')!.textContent).toContain('L01SecondPage');
  expect(document.getElementById('databaseObjectsCount-table')!.textContent).toBe('2');
});

it('opens a virtualized table grid and keeps sort, filters and paging on the server', async () => {
  api.searchDatabaseObjects!.mockImplementation(() => reply({
    objects: [{ schema: 'dbo', name: 'L00ZONES', type: 'table', objectId: 42, modifiedAt: null }],
    hasMore: false,
    elapsedMs: 2
  }));
  api.readDatabaseTablePage!.mockImplementation((request: {
    cursor?: string;
    sort?: { column: string; direction: string };
    filters?: Array<{ column: string; operator: string; value?: unknown }>;
  }) => {
    const rows = Array.from({ length: request.cursor ? 12 : 100 }, (_, index) => ({
      Zone: `${request.cursor ? 'N' : 'Z'}${String(index).padStart(3, '0')}`,
      Description: request.filters?.length ? 'Bank filtered' : `Description ${index}`
    }));
    return reply({
      schema: 'dbo',
      table: 'L00ZONES',
      columns: [
        { name: 'Zone', type: 'varchar', nullable: false, primaryKeyOrdinal: 1 },
        { name: 'Description', type: 'nvarchar', nullable: false, primaryKeyOrdinal: null }
      ],
      rows,
      hasMore: !request.cursor,
      ...(!request.cursor ? { nextCursor: 'page-2' } : {}),
      elapsedMs: 4,
      pagingMode: 'keyset'
    });
  });

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const tables = document.querySelector<HTMLDetailsElement>('.database-object-group[data-object-type="table"]')!;
  tables.open = true;
  tables.dispatchEvent(new dom.window.Event('toggle'));
  await tick();
  document.querySelector<HTMLButtonElement>('#databaseObjects-table .database-object-row')!.click();
  await tick();

  expect(api.readDatabaseTablePage).toHaveBeenLastCalledWith({
    connection: 'linkq-test',
    objectId: 42,
    limit: 100
  });
  expect(document.querySelector('.database-object-workspace-content')!.classList.contains('database-grid-host')).toBe(true);
  expect(api.readDatabaseObjectDetails).not.toHaveBeenCalled();
  expect(api.setDatabaseWorkspaceContext).toHaveBeenCalledWith(expect.objectContaining({
    connection: 'linkq-test',
    object: { objectId: 42, schema: 'dbo', name: 'L00ZONES', type: 'table' },
    tab: 'data',
    page: 1
  }));
  expect(document.querySelectorAll('.database-data-grid tbody tr[data-row-index]').length).toBeLessThan(100);
  expect(document.querySelectorAll('.database-data-grid tbody tr[data-row-index]').length).toBeGreaterThan(0);
  expect(document.querySelectorAll('.database-data-grid tbody tr[data-row-index]').length).toBeLessThanOrEqual(22);

  const firstCol = document.querySelector<HTMLTableColElement>('.database-data-grid colgroup col[data-column]')!;
  const firstResize = document.querySelector<HTMLElement>('.database-grid-column-resize')!;
  expect(firstCol.style.width).toBe('150px');
  firstResize.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  expect(Number.parseInt(firstCol.style.width, 10)).toBeGreaterThanOrEqual(80);
  expect(Number.parseInt(firstCol.style.width, 10)).toBeLessThanOrEqual(900);

  const firstCell = document.querySelector<HTMLTableCellElement>('.database-data-grid tbody td[data-row-index="0"][data-column-index="0"]')!;
  firstCell.click();
  expect(firstCell.classList.contains('is-grid-focused')).toBe(true);
  firstCell.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  expect(document.querySelector('.database-grid-cell-editor')).toBeNull();
  expect(document.querySelector('.database-grid-status')!.textContent).toContain('Read-only');
  const gridScroll = document.querySelector<HTMLElement>('.database-grid-scroll')!;
  gridScroll.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  expect(document.querySelectorAll('.database-data-grid td.is-grid-selected-all').length).toBeGreaterThan(0);
  gridScroll.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
  await tick();
  expect(api.writeClipboard).toHaveBeenCalledTimes(1);
  expect(api.writeClipboard!.mock.calls[0]![0]).toContain('Zone\tDescription');
  expect(api.writeClipboard!.mock.calls[0]![0]).toContain('Z000\tDescription 0');
  expect(api.setDatabaseWorkspaceContext).toHaveBeenLastCalledWith(expect.not.objectContaining({ selectedRows: expect.anything() }));

  expect(document.querySelector('.database-ai-context-badge')!.textContent).toContain('0 selected');
  let databaseChatRequests = 0;
  dom.window.addEventListener('cos:database-open-chat', () => { databaseChatRequests += 1; });
  document.querySelector<HTMLButtonElement>('.database-ai-row-toggle')!.click();
  await tick();
  expect(api.setDatabaseWorkspaceContext).toHaveBeenLastCalledWith(expect.objectContaining({
    connection: 'linkq-test',
    tab: 'data',
    page: 1,
    selectedRows: [expect.objectContaining({ Zone: 'Z000' })]
  }));
  expect(document.querySelector('.database-ai-context-badge')!.textContent).toContain('1 selected');
  expect(document.querySelector('.database-ai-context-explainer')!.textContent).toContain('Ask ChatGPT');
  document.querySelector<HTMLButtonElement>('.database-ai-context-ask')!.click();
  expect(databaseChatRequests).toBe(1);
  document.querySelector<HTMLButtonElement>('.database-ai-context-clear')!.click();
  await tick();
  expect(document.querySelector('.database-ai-context-badge')!.textContent).toContain('0 selected');

  const shortcutCell = document.querySelector<HTMLTableCellElement>('.database-data-grid tbody td[data-row-index="0"][data-column-index="0"]')!;
  shortcutCell.click();
  gridScroll.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '+', shiftKey: true, bubbles: true }));
  await tick();
  expect(databaseChatRequests).toBe(2);
  expect(api.setDatabaseWorkspaceContext).toHaveBeenLastCalledWith(expect.objectContaining({
    selectedRows: [expect.objectContaining({ Zone: 'Z000' })]
  }));

  const density = document.querySelector<HTMLSelectElement>('.database-grid-density')!;
  density.value = 'compact';
  density.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(document.querySelector<HTMLElement>('.database-grid-host')!.dataset.gridDensity).toBe('compact');

  document.querySelector<HTMLButtonElement>('.database-grid-row-details-toggle')!.click();
  document.querySelector<HTMLTableCellElement>('.database-data-grid tbody td[data-row-index="0"][data-column-index="0"]')!.click();
  expect(document.querySelector('.database-row-inspector')!.textContent).toContain('Zone');
  expect(document.querySelector('.database-row-inspector')!.textContent).toContain('Z000');

  const columnOptions = [...document.querySelectorAll<HTMLInputElement>('.database-grid-column-option input')];
  expect(columnOptions).toHaveLength(2);
  columnOptions[1]!.checked = false;
  columnOptions[1]!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect([...document.querySelectorAll<HTMLButtonElement>('.database-grid-sort')].map(button => button.textContent)).toEqual(['Zone']);
  const refreshedOptions = [...document.querySelectorAll<HTMLInputElement>('.database-grid-column-option input')];
  refreshedOptions[1]!.checked = true;
  refreshedOptions[1]!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  const zoneSort = [...document.querySelectorAll<HTMLButtonElement>('.database-grid-sort')]
    .find(button => button.textContent?.startsWith('Zone'))!;
  zoneSort.click();
  await tick();
  expect(api.readDatabaseTablePage).toHaveBeenLastCalledWith(expect.objectContaining({
    connection: 'linkq-test',
    objectId: 42,
    limit: 100,
    sort: { column: 'Zone', direction: 'asc' }
  }));

  const filterColumn = document.querySelector<HTMLSelectElement>('.database-grid-filter-column')!;
  filterColumn.value = 'Description';
  filterColumn.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const filterOperator = document.querySelector<HTMLSelectElement>('.database-grid-filter-operator')!;
  filterOperator.value = 'starts_with';
  filterOperator.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const filterValue = document.querySelector<HTMLInputElement>('.database-grid-filter-value')!;
  filterValue.value = 'Bank';
  document.querySelector<HTMLButtonElement>('.database-grid-filter-add')!.click();
  await tick();
  expect(api.readDatabaseTablePage).toHaveBeenLastCalledWith(expect.objectContaining({
    filters: [{ column: 'Description', operator: 'starts_with', value: 'Bank' }]
  }));
  expect(api.setDatabaseWorkspaceContext).toHaveBeenLastCalledWith(expect.objectContaining({
    filters: [{ column: 'Description', operator: 'starts_with', value: 'Bank' }],
    sort: { column: 'Zone', direction: 'asc' },
    page: 1
  }));

  document.querySelector<HTMLButtonElement>('.database-grid-next')!.click();
  await tick();
  expect(api.readDatabaseTablePage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'page-2' }));

  const columnsTab = [...document.querySelectorAll<HTMLButtonElement>('.database-object-tab')]
    .find(button => button.dataset.tab === 'columns')!;
  columnsTab.click();
  await tick();
  expect(api.readDatabaseObjectDetails).toHaveBeenLastCalledWith({
    connection: 'linkq-test',
    objectId: 42,
    section: 'columns'
  });
  expect(document.querySelector('.database-detail-table')!.textContent).toContain('Zone');
  document.querySelector<HTMLButtonElement>('.database-detail-copy')!.click();
  await tick();
  expect(api.writeClipboard).toHaveBeenLastCalledWith(expect.stringContaining('#\tColumn\tType'));
  expect(api.setDatabaseWorkspaceContext).toHaveBeenLastCalledWith({
    connection: 'linkq-test',
    object: { objectId: 42, schema: 'dbo', name: 'L00ZONES', type: 'table' },
    tab: 'columns'
  });
});

it('edits one non-key cell only in Full access and waits for Save changes before writing', async () => {
  state.settings.connections[0]!.accessMode = 'full-access';
  api.searchDatabaseObjects!.mockImplementation(() => reply({
    objects: [{ schema: 'dbo', name: 'L00ZONES', type: 'table', objectId: 42, modifiedAt: null }],
    hasMore: false,
    elapsedMs: 2
  }));
  api.readDatabaseTablePage!.mockImplementation(() => reply({
    schema: 'dbo',
    table: 'L00ZONES',
    columns: [
      { name: 'Zone', type: 'varchar', nullable: false, primaryKeyOrdinal: 1, identity: false, computed: false },
      { name: 'Description', type: 'nvarchar', nullable: true, primaryKeyOrdinal: null, identity: false, computed: false }
    ],
    rows: [{ Zone: 'ANSWERS', Description: 'Câu trả lời' }],
    hasMore: false,
    elapsedMs: 3,
    pagingMode: 'keyset'
  }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const tables = document.querySelector<HTMLDetailsElement>('.database-object-group[data-object-type="table"]')!;
  tables.open = true;
  tables.dispatchEvent(new dom.window.Event('toggle'));
  await tick();
  document.querySelector<HTMLButtonElement>('#databaseObjects-table .database-object-row')!.click();
  await tick();

  expect(document.querySelector('.database-grid-access')!.textContent).toContain('Full access');
  const descriptionCell = document.querySelector<HTMLTableCellElement>('.database-data-grid tbody td[data-row-index="0"][data-column-index="1"]')!;
  descriptionCell.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  const editor = document.querySelector<HTMLInputElement>('.database-grid-cell-editor')!;
  expect(editor).toBeTruthy();
  editor.value = 'A';
  editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  expect(api.updateDatabaseTableCell).not.toHaveBeenCalled();
  expect((document.querySelector('.database-grid-edit-actions') as HTMLElement).hidden).toBe(false);
  expect(document.querySelector('.database-grid-status')!.textContent).toContain('pending change');

  document.querySelector<HTMLButtonElement>('.database-grid-save-edit')!.click();
  await tick();
  expect(api.updateDatabaseTableCell).toHaveBeenCalledWith({
    connection: 'linkq-test',
    objectId: 42,
    column: 'Description',
    primaryKey: { Zone: 'ANSWERS' },
    originalValue: 'Câu trả lời',
    value: 'A'
  });
  expect(document.querySelector<HTMLTableCellElement>('.database-data-grid tbody td[data-row-index="0"][data-column-index="1"]')!.textContent).toBe('A');
  expect((document.querySelector('.database-grid-edit-actions') as HTMLElement).hidden).toBe(true);
});

it('loads programmable-object DDL first and fetches dependencies only when that tab opens', async () => {
  api.searchDatabaseObjects!.mockImplementation(() => reply({
    objects: [{ schema: 'dbo', name: 'Sp_BankHistory', type: 'procedure', objectId: 77, modifiedAt: null }],
    hasMore: false,
    elapsedMs: 2
  }));
  api.readDatabaseObjectDetails!.mockImplementation((request: { section: string }) => reply({
    schema: 'dbo',
    name: 'Sp_BankHistory',
    type: 'procedure',
    section: request.section,
    ...(request.section === 'ddl'
      ? { ddl: { text: 'CREATE PROCEDURE dbo.Sp_BankHistory AS SELECT 1;', kind: 'source', complete: true } }
      : {
          outboundDependencies: [{ schema: 'dbo', name: 'L01BankHistory', type: 'table', database: null, server: null }],
          inboundDependencies: []
        }),
    elapsedMs: 3
  }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const procedures = document.querySelector<HTMLDetailsElement>('.database-object-group[data-object-type="procedure"]')!;
  procedures.open = true;
  procedures.dispatchEvent(new dom.window.Event('toggle'));
  await tick();
  document.querySelector<HTMLButtonElement>('#databaseObjects-procedure .database-object-row')!.click();
  await tick();

  expect(api.readDatabaseObjectDetails).toHaveBeenCalledTimes(1);
  expect(api.readDatabaseObjectDetails).toHaveBeenLastCalledWith({ connection: 'linkq-test', objectId: 77, section: 'ddl' });
  expect(document.querySelector('.database-ddl-source')!.textContent).toContain('CREATE PROCEDURE');
  const wrap = document.querySelector<HTMLButtonElement>('.database-ddl-wrap')!;
  expect(wrap.textContent).toBe('Wrap');
  wrap.click();
  expect(document.querySelector('.database-ddl-source')!.classList.contains('is-wrapped')).toBe(true);
  expect(wrap.textContent).toBe('No wrap');
  expect([...document.querySelectorAll<HTMLButtonElement>('.database-object-tab')].map(button => button.dataset.tab)).toEqual(['ddl', 'dependencies']);

  document.querySelector<HTMLButtonElement>('.database-object-tab[data-tab="dependencies"]')!.click();
  await tick();
  expect(api.readDatabaseObjectDetails).toHaveBeenCalledTimes(2);
  expect(api.readDatabaseObjectDetails).toHaveBeenLastCalledWith({ connection: 'linkq-test', objectId: 77, section: 'dependencies' });
  expect(document.querySelector('.database-dependency-list')!.textContent).toContain('dbo.L01BankHistory');
});





