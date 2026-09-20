import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import type { DatabaseGrowthCompareRequest, DatabaseSettingsState } from '../src/shared/database.js';

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
      tableFingerprints: [{ schema: 'dbo', name: 'L00ZONES', columnCount: 4, indexCount: 2, columnHash: '100', indexHash: '200' }],
      schemaTruncated: false,
      limitations: []
    })),
    compareDatabaseGrowth: vi.fn((request: DatabaseGrowthCompareRequest) => reply({
      baseline: {
        connection: request.baseline.connection,
        database: 'L80LINKQ_2025',
        capturedAt: '2026-09-16T01:00:00.000Z',
        ...(request.baselineAsOf ? { asOf: request.baselineAsOf } : {}),
        source: request.baseline.type,
        ...(request.baseline.type === 'snapshot' ? { snapshotId: request.baseline.snapshotId } : {}),
        tablesTruncated: false,
        schemaTruncated: false
      },
      current: {
        connection: request.current.connection,
        database: 'L80LINKQ.TEST',
        capturedAt: '2026-09-16T01:00:01.000Z',
        source: request.current.type,
        ...(request.current.type === 'snapshot' ? { snapshotId: request.current.snapshotId } : {}),
        tablesTruncated: false,
        schemaTruncated: false
      },
      summary: {
        totalAllocatedDeltaMb: 20480,
        dataAllocatedDeltaMb: 17408,
        dataUsedDeltaMb: 14800,
        logAllocatedDeltaMb: 3072,
        logUsedDeltaMb: 400,
        tableUsedDeltaMb: 11755,
        unattributedDataUsedDeltaMb: 3045,
        attributionPercent: 79.43,
        tableCountDelta: 23,
        addedTableCount: 23,
        removedTableCount: 0,
        schemaChangedTableCount: 1
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
      schemaDeltas: [{
        schema: 'dbo', name: 'L01BANKHISTORY', baselineObjectId: 10, currentObjectId: 900,
        columnChanged: true, indexChanged: true,
        baselineColumnCount: 8, currentColumnCount: 10,
        baselineIndexCount: 2, currentIndexCount: 4
      }],
      totalSchemaDifferenceCount: 1,
      returnedSchemaDifferenceCount: 1,
      omittedSchemaDifferenceCount: 0,
      limitations: []
    })),
    readDatabaseGrowthHistory: vi.fn(() => reply({ connection: 'linkq-test', snapshots: [] })),
    saveDatabaseGrowthSnapshot: vi.fn((_id: string, snapshot: unknown) => reply({
      connection: 'linkq-test',
      snapshots: [{ id: '11111111-1111-4111-8111-111111111111', connection: 'linkq-test', savedAt: '2026-09-15T17:01:00.000Z', ...(snapshot as object) }]
    })),
    deleteDatabaseGrowthSnapshot: vi.fn((id: string) => reply({ connection: id, snapshots: [] })),
    clearDatabaseGrowthHistory: vi.fn((id: string) => reply({ connection: id, snapshots: [] })),
    readDatabaseIncidentWatchStatus: vi.fn((id: string) => reply({
      connection: id,
      watching: false,
      intervalMs: 10000,
      startedAt: null,
      lastCheckedAt: null,
      lastCapturedAt: null,
      capturedCount: 0,
      incidentActive: false,
      lastError: null
    })),
    startDatabaseIncidentWatch: vi.fn((id: string) => reply({
      connection: id,
      watching: true,
      intervalMs: 10000,
      startedAt: '2026-09-19T02:00:00.000Z',
      lastCheckedAt: null,
      lastCapturedAt: null,
      capturedCount: 0,
      incidentActive: false,
      lastError: null
    })),
    stopDatabaseIncidentWatch: vi.fn((id: string) => reply({
      connection: id,
      watching: false,
      intervalMs: 10000,
      startedAt: '2026-09-19T02:00:00.000Z',
      lastCheckedAt: '2026-09-19T02:01:00.000Z',
      lastCapturedAt: null,
      capturedCount: 0,
      incidentActive: false,
      lastError: null
    })),
    clearDatabaseIncidentHistory: vi.fn((id: string) => reply({ connection: id, snapshots: [] })),
    traceDatabaseIncidentCause: vi.fn((request: { connection: string; sql: string; sourceRoot: string }) => reply({
      connection: request.connection,
      database: 'L80LINKQ.TEST',
      candidates: [
        { kind: 'table', schema: 'dbo', table: 'L09TDDMUNGVIEN', name: 'L09TDDMUNGVIEN', confidence: 'high', evidence: 'UPDATE target' },
        { kind: 'column', schema: 'dbo', table: 'L09TDDMUNGVIEN', name: 'Ten_UvTd', confidence: 'high', evidence: 'UPDATE SET column' }
      ],
      confirmedField: { objectId: 42, schema: 'dbo', table: 'L09TDDMUNGVIEN', columnId: 2, column: 'Ten_UvTd', type: 'nvarchar(200)', nullable: true, identity: false, computed: false, primaryKey: false, indexed: false },
      consumers: [{ objectId: 100, schema: 'dbo', name: 'Sp_SaveUngVien', type: 'SQL_STORED_PROCEDURE', dependencyDirection: 'references-table', confidence: 'high', reason: 'SQL Server dependency and column text evidence.' }],
      source: {
        sourceRoot: request.sourceRoot,
        searchedFiles: 120,
        skippedFiles: 4,
        matches: [{ path: '/src-net10-1.0.0/Modules/HRM/Recruitment/frmUngVien.cs', line: 84, preview: 'txtTenUv.DataBindings.Add("Text", source, "Ten_UvTd");', kind: 'winforms-binding', matchedTerm: 'Ten_UvTd', confidence: 'high' }],
        truncated: false,
        limitations: [],
        elapsedMs: 9
      },
      limitations: [],
      elapsedMs: 14
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
    searchDatabaseColumns: vi.fn((_id: string, search: string) => reply({
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      search,
      matches: [{ objectId: 42, schema: 'dbo', table: 'L09TDDMUNGVIEN', columnId: 1, column: 'Ma_UvTd', type: 'varchar(20)', nullable: false, identity: false, computed: false, primaryKey: true, indexed: true }],
      truncated: false,
      elapsedMs: 3
    })),
    profileDatabaseColumn: vi.fn(() => reply({
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      object: { objectId: 42, schema: 'dbo', table: 'L09TDDMUNGVIEN' },
      column: { objectId: 42, schema: 'dbo', table: 'L09TDDMUNGVIEN', columnId: 1, column: 'Ma_UvTd', type: 'varchar(20)', nullable: false, identity: false, computed: false, primaryKey: true, indexed: true },
      sampleLimit: 10000,
      sampledRows: 755,
      nullRows: 0,
      blankRows: 2,
      distinctValues: 741,
      minValue: 'UV001',
      maxValue: 'UV999',
      maxDataLengthBytes: 12,
      examples: [{ value: 'UV001', count: 2 }],
      limitations: ['Profile statistics use at most 10,000 rows.'],
      elapsedMs: 4
    })),
    readDatabaseFieldConsumers: vi.fn(() => reply({
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      source: { objectId: 42, schema: 'dbo', table: 'L09TDDMUNGVIEN', column: 'Ma_UvTd' },
      consumers: [{ objectId: 100, schema: 'dbo', name: 'Sp_LoadUngVien', type: 'SQL_STORED_PROCEDURE', dependencyDirection: 'references-table', confidence: 'high', reason: 'SQL Server records a dependency on the table and the module text mentions this column.' }],
      limitations: [],
      elapsedMs: 2
    })),
    traceDatabaseSource: vi.fn(() => reply({
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      source: { objectId: 42, schema: 'dbo', table: 'L09TDDMUNGVIEN', column: 'Ma_UvTd' },
      sourceRoot: '/src-net10-1.0.0',
      searchedFiles: 120,
      skippedFiles: 4,
      matches: [{ path: 'Modules/HRM/Recruitment/frmUngVien.cs', line: 84, preview: 'txtMaUv.DataBindings.Add("Text", source, "Ma_UvTd");', kind: 'winforms-binding', confidence: 'high' }],
      truncated: false,
      limitations: [],
      elapsedMs: 9
    })),
    compareDatabaseSchemas: vi.fn((request: { baselineConnection: string; currentConnection: string }) => reply({
      baseline: { connection: request.baselineConnection, database: 'L80LINKQ.OLD', capturedAt: '2026-09-17T01:00:00.000Z' },
      current: { connection: request.currentConnection, database: 'L80LINKQ.TEST', capturedAt: '2026-09-17T02:00:00.000Z' },
      summary: {
        tablesAdded: 0, tablesRemoved: 0,
        columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0,
        indexesAdded: 0, indexesRemoved: 0, indexesChanged: 0,
        proceduresAdded: 0, proceduresRemoved: 0, proceduresChanged: 1,
        viewsAdded: 0, viewsRemoved: 0, viewsChanged: 0
      },
      differences: [{
        kind: 'procedure-changed',
        object: 'dbo.Sp_GetUngVien',
        detail: 'Stored procedure definition changed.',
        baseline: 'CREATE PROCEDURE dbo.Sp_GetUngVien AS SELECT Ma_UvTd FROM dbo.L09TDDMUNGVIEN;',
        current: 'ALTER PROCEDURE dbo.Sp_GetUngVien AS SELECT Ma_UvTd, Ten_UvTd FROM dbo.L09TDDMUNGVIEN;',
        confidence: 'high'
      }],
      totalDifferenceCount: 1,
      truncated: false,
      limitations: [],
      elapsedMs: 6
    })),
    setDatabaseWorkspaceContext: vi.fn((context: unknown) => reply(context))
  };
  Object.assign(dom.window, { api });
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('organizes Database as a workspace and switches its fork UI between English and Vietnamese', async () => {
  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  expect(document.querySelector('.database-workspace-header h2')!.textContent).toBe('Database Workspace');
  expect((document.querySelector('[data-database-workspace-view="investigate"]') as HTMLElement).hidden).toBe(false);
  expect((document.querySelector('[data-database-workspace-view="connections"]') as HTMLElement).hidden).toBe(true);

  (document.querySelector('[data-database-view="connections"]') as HTMLButtonElement).click();
  expect((document.querySelector('[data-database-workspace-view="investigate"]') as HTMLElement).hidden).toBe(true);
  expect((document.querySelector('[data-database-workspace-view="connections"]') as HTMLElement).hidden).toBe(false);

  const vietnamese = document.querySelector<HTMLButtonElement>('[data-database-language="vi"]')!;
  vietnamese.click();
  expect(vietnamese.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.database-workspace-header h2')!.textContent).toBe('Không gian cơ sở dữ liệu');
  expect(document.querySelector('[data-database-view="connections"]')!.textContent).toBe('Kết nối');
  expect(document.querySelector('.database-investigator-head h2')!.textContent).toBe('Điều tra database');
});

it('searches one ERP field and uses the Analyze menu for data, SQL and C#/WinForms evidence', async () => {
  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  (document.querySelector('[data-investigator-tab="column"]') as HTMLButtonElement).click();
  const search = document.getElementById('databaseInvestigatorColumnSearch') as HTMLInputElement;
  search.value = 'Ma_UvTd';
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();

  expect(api.searchDatabaseColumns).toHaveBeenCalledWith('linkq-test', 'Ma_UvTd');
  const match = document.querySelector<HTMLButtonElement>('.database-column-result')!;
  expect(match.textContent).toContain('dbo.L09TDDMUNGVIEN.Ma_UvTd');
  expect(match.textContent).toContain('varchar(20)');
  match.click();

  const profile = document.querySelector<HTMLButtonElement>('[data-db-label="Profile data"]')!;
  profile.click();
  await tick();
  expect(api.profileDatabaseColumn).toHaveBeenCalledWith({ connection: 'linkq-test', objectId: 42, column: 'Ma_UvTd' });
  expect(document.querySelector('.database-investigator-grid')!.textContent).toContain('755');
  expect(document.querySelector('.database-investigator-grid')!.textContent).toContain('741');

  const findConsumers = document.querySelector<HTMLButtonElement>('[data-db-label="Find SQL consumers"]')!;
  findConsumers.click();
  await tick();
  expect(api.readDatabaseFieldConsumers).toHaveBeenCalledWith({ connection: 'linkq-test', objectId: 42, column: 'Ma_UvTd' });
  const consumerTable = [...document.querySelectorAll<HTMLElement>('.database-investigator-table')]
    .find(node => node.textContent?.includes('dbo.Sp_LoadUngVien'))!;
  expect(consumerTable.textContent).toContain('dbo.Sp_LoadUngVien');
  expect(consumerTable.textContent).toContain('high');

  const sourceRoot = document.getElementById('databaseInvestigatorSourceRoot') as HTMLInputElement;
  sourceRoot.value = '/src-net10-1.0.0';
  const trace = document.querySelector<HTMLButtonElement>('[data-db-label="Trace C#/WinForms"]')!;
  trace.click();
  await tick();
  expect(api.traceDatabaseSource).toHaveBeenCalledWith({ connection: 'linkq-test', objectId: 42, column: 'Ma_UvTd', sourceRoot: '/src-net10-1.0.0' });
  expect(document.querySelector('.database-source-preview')!.textContent).toContain('DataBindings.Add');
});

it('offers one Tools menu that jumps directly to the V2 investigators', async () => {
  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const tools = document.querySelector<HTMLDetailsElement>('.database-investigator-more')!;
  const labels = [...tools.querySelectorAll<HTMLButtonElement>('.database-investigator-menu-item')].map(node => node.textContent);
  expect(labels).toEqual(expect.arrayContaining([
    'Field & C#/WinForms trace',
    'Query Store history',
    'Deadlock history',
    'Procedure & View Compare',
    'SQL Agent Jobs'
  ]));

  tools.querySelector<HTMLButtonElement>('[data-db-label="Query Store history"]')!.click();
  expect(document.querySelector('.database-investigator-titlebar h3')!.textContent).toBe('Query Store history');

  tools.querySelector<HTMLButtonElement>('[data-db-label="Procedure & View Compare"]')!.click();
  expect(document.querySelector('.database-investigator-titlebar h3')!.textContent).toBe('Procedure & View Compare');
});

it('renders Procedure and View differences as readable baseline-current code cards', async () => {
  state.settings.connections.unshift({
    id: 'linkq-old',
    name: 'LinkQ Old',
    provider: 'sqlserver',
    accessMode: 'read-only',
    server: 'linkq-old.local',
    database: 'L80LINKQ.OLD',
    port: 1433,
    encrypt: false,
    trustServerCertificate: true,
    authentication: { type: 'sql', user: 'long' }
  });

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  document.querySelector<HTMLButtonElement>('[data-db-label="Procedure & View Compare"]')!.click();
  document.querySelector<HTMLButtonElement>('.database-schema-controls .is-primary')!.click();
  await tick();

  expect(api.compareDatabaseSchemas).toHaveBeenCalledWith({ baselineConnection: 'linkq-old', currentConnection: 'linkq-test' });
  const card = document.querySelector<HTMLElement>('.database-code-diff-card')!;
  expect(card.textContent).toContain('dbo.Sp_GetUngVien');
  expect(card.textContent).toContain('Procedure changed');
  expect(card.textContent).toContain('high');
  expect(card.textContent).toContain('Stored procedure definition changed.');
  const versions = [...card.querySelectorAll<HTMLElement>('.database-compare-snippet')].map(node => node.textContent);
  expect(versions[0]).toContain('SELECT Ma_UvTd FROM');
  expect(versions[1]).toContain('SELECT Ma_UvTd, Ten_UvTd FROM');
});

it('shows saved Incident Snapshot session evidence as a blocking tree and keeps legacy snapshots readable', async () => {
  const currentId = '33333333-3333-4333-8333-333333333333';
  const legacyId = '44444444-4444-4444-8444-444444444444';
  api.readDatabaseIncidentHistory = vi.fn(() => reply({
    connection: 'linkq-test',
    snapshots: [{
      id: currentId,
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-19T01:30:00.000Z',
      savedAt: '2026-09-19T01:30:01.000Z',
      summary: { totalMb: 2048, dataUsedMb: 1500, logUsedPercent: 33, activeRequestCount: 3, blockedRequestCount: 2, failedJobCount: 0 },
      requests: [{
        sessionId: 51,
        status: 'sleeping',
        command: 'idle',
        database: 'L80LINKQ.TEST',
        login: 'erp_user',
        host: 'ERP-SRV-01',
        program: 'LinkQ ERP',
        elapsedMs: 0,
        cpuMs: 0,
        logicalReads: 10,
        writes: 0,
        waitType: null,
        lastWaitType: null,
        waitMs: 0,
        waitResource: null,
        blockingSessionId: 0,
        openTransactionCount: 1,
        transactionBeginTime: '2026-09-19T01:23:00.000Z',
        transactionAgeSeconds: 420,
        queryHash: null,
        queryPlanHash: null,
        isBlocked: false,
        isBlocker: true,
        isRootBlocker: true,
        isSleepingTransaction: true,
        reasonMask: 12,
        sql: 'UPDATE dbo.L09TDDMUNGVIEN SET Ten_UvTd = @name WHERE Ma_UvTd = @id'
      }, {
        sessionId: 52,
        status: 'suspended',
        command: 'SELECT',
        database: 'L80LINKQ.TEST',
        login: 'report_user',
        host: 'REPORT-01',
        program: 'LinkQ Report',
        elapsedMs: 73000,
        cpuMs: 1200,
        logicalReads: 9000,
        writes: 0,
        waitType: 'LCK_M_S',
        lastWaitType: 'LCK_M_S',
        waitMs: 65000,
        waitResource: 'KEY: 7:72057594012345678',
        blockingSessionId: 51,
        openTransactionCount: 0,
        transactionBeginTime: null,
        transactionAgeSeconds: null,
        queryHash: '0xAAA',
        queryPlanHash: '0xBBB',
        isBlocked: true,
        isBlocker: true,
        isRootBlocker: false,
        isSleepingTransaction: false,
        reasonMask: 11,
        sql: 'SELECT * FROM dbo.L09TDDMUNGVIEN'
      }, {
        sessionId: 53,
        status: 'suspended',
        command: 'SELECT',
        database: 'L80LINKQ.TEST',
        login: 'desk_user',
        host: 'DESK-01',
        program: 'LinkQ HRM',
        elapsedMs: 15000,
        cpuMs: 50,
        logicalReads: 120,
        writes: 0,
        waitType: 'LCK_M_S',
        lastWaitType: 'LCK_M_S',
        waitMs: 12000,
        waitResource: 'KEY: 7:72057594087654321',
        blockingSessionId: 52,
        openTransactionCount: 0,
        transactionBeginTime: null,
        transactionAgeSeconds: null,
        queryHash: null,
        queryPlanHash: null,
        isBlocked: true,
        isBlocker: false,
        isRootBlocker: false,
        isSleepingTransaction: false,
        reasonMask: 9,
        sql: 'SELECT Ten_UvTd FROM dbo.L09TDDMUNGVIEN'
      }, {
        sessionId: 54,
        status: 'suspended',
        command: 'UPDATE',
        database: 'L80LINKQ.TEST',
        login: 'batch_user',
        host: 'BATCH-01',
        program: 'LinkQ Batch',
        elapsedMs: 11000,
        cpuMs: 300,
        logicalReads: 40,
        writes: 2,
        waitType: 'LCK_M_U',
        lastWaitType: 'LCK_M_U',
        waitMs: 10500,
        waitResource: 'OBJECT: 7:42:0',
        blockingSessionId: -2,
        openTransactionCount: 1,
        transactionBeginTime: '2026-09-19T01:29:00.000Z',
        transactionAgeSeconds: 60,
        queryHash: null,
        queryPlanHash: null,
        isBlocked: true,
        isBlocker: false,
        isRootBlocker: false,
        isSleepingTransaction: false,
        reasonMask: 1,
        sql: 'UPDATE dbo.L00ZONES SET Zone = Zone'
      }],
      jobs: [],
      findings: [],
      limitations: []
    }, {
      id: legacyId,
      connection: 'linkq-test',
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-18T01:30:00.000Z',
      savedAt: '2026-09-18T01:30:01.000Z',
      summary: { totalMb: 2000, dataUsedMb: 1400, logUsedPercent: 20, activeRequestCount: 1, blockedRequestCount: 0, failedJobCount: null },
      requests: [{
        sessionId: 77,
        status: 'running',
        command: 'SELECT',
        database: 'L80LINKQ.TEST',
        login: 'legacy_user',
        host: 'OLD-CLIENT',
        program: 'Legacy WinForms',
        elapsedMs: 1200,
        cpuMs: 100,
        logicalReads: 2,
        writes: 0,
        waitType: null,
        waitMs: 0,
        blockingSessionId: 0,
        openTransactionCount: 0,
        sql: 'SELECT 1 AS LegacySnapshot'
      }],
      jobs: [],
      findings: [],
      limitations: []
    }]
  }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const loadHistory = [...document.querySelectorAll<HTMLButtonElement>('.database-investigator-actions .btn')]
    .find(node => node.textContent === 'Load history')!;
  loadHistory.click();
  await tick();

  expect(api.readDatabaseIncidentHistory).toHaveBeenCalledWith('linkq-test');
  const rootBlocker = document.querySelector<HTMLElement>('.database-blocking-node[data-session-id="51"]')!;
  const blockedChild = rootBlocker.querySelector<HTMLElement>('.database-blocking-node[data-session-id="52"]')!;
  expect(rootBlocker.textContent).toContain('Root blocker');
  expect(rootBlocker.textContent).toContain('Sleeping transaction');
  expect(rootBlocker.textContent).toContain('Long transaction');
  expect(rootBlocker.textContent).toContain('ERP-SRV-01');
  expect(rootBlocker.textContent).toContain('LinkQ ERP');
  expect(rootBlocker.textContent).toContain('7 min');
  expect(rootBlocker.textContent).toContain('UPDATE dbo.L09TDDMUNGVIEN');
  expect(blockedChild.textContent).toContain('Blocked');
  expect(blockedChild.textContent).toContain('Long request');
  expect(blockedChild.textContent).toContain('KEY: 7:72057594012345678');
  expect(blockedChild.querySelector('.database-blocking-node[data-session-id="53"]')).toBeTruthy();
  expect(document.querySelector<HTMLElement>('.database-blocking-node[data-session-id="54"]')!.textContent).toContain('Special blocker -2');

  const sourceRoot = document.getElementById('databaseInvestigatorSourceRoot') as HTMLInputElement;
  sourceRoot.value = '/src-net10-1.0.0';
  sourceRoot.dispatchEvent(new dom.window.Event('change'));
  rootBlocker.querySelector<HTMLButtonElement>('.database-incident-trace')!.click();
  await tick();

  expect(api.traceDatabaseIncidentCause).toHaveBeenCalledWith({
    connection: 'linkq-test',
    sql: 'UPDATE dbo.L09TDDMUNGVIEN SET Ten_UvTd = @name WHERE Ma_UvTd = @id',
    sourceRoot: '/src-net10-1.0.0'
  });
  const cause = document.querySelector<HTMLElement>('.database-incident-cause')!;
  expect(cause.textContent).toContain('ERP Cause Trace · Session 51');
  expect(cause.textContent).toContain('dbo.L09TDDMUNGVIEN.Ten_UvTd');
  expect(cause.textContent).toContain('Sp_SaveUngVien');
  expect(cause.textContent).toContain('frmUngVien.cs');

  const legacyRow = [...document.querySelectorAll<HTMLElement>('.database-incident-row')]
    .find(node => node.textContent?.includes('9/18/2026')) ?? document.querySelectorAll<HTMLElement>('.database-incident-row')[1]!;
  [...legacyRow.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'View details')!.click();

  const legacy = document.querySelector<HTMLElement>('.database-blocking-node[data-session-id="77"]')!;
  expect(legacy.textContent).toContain('legacy_user');
  expect(legacy.textContent).toContain('OLD-CLIENT');
  expect(legacy.textContent).toContain('Legacy WinForms');
  expect(legacy.textContent).toContain('SELECT 1 AS LegacySnapshot');
  expect(legacy.textContent).toContain('Transaction age—');
});

it('starts and stops Incident Black Box watch and can clear local incident history', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();
  await tick();

  expect(api.readDatabaseIncidentWatchStatus).toHaveBeenCalledWith('linkq-test');
  expect(document.querySelector('.database-incident-watch')!.textContent).toContain('Stopped');

  [...document.querySelectorAll<HTMLButtonElement>('.database-investigator-actions .btn')]
    .find(node => node.textContent === 'Start Watch')!.click();
  await tick();
  expect(api.startDatabaseIncidentWatch).toHaveBeenCalledWith('linkq-test');
  expect(document.querySelector('.database-incident-watch')!.textContent).toContain('Watching');

  [...document.querySelectorAll<HTMLButtonElement>('.database-investigator-actions .btn')]
    .find(node => node.textContent === 'Stop Watch')!.click();
  await tick();
  expect(api.stopDatabaseIncidentWatch).toHaveBeenCalledWith('linkq-test');

  [...document.querySelectorAll<HTMLButtonElement>('.database-investigator-actions .btn')]
    .find(node => node.textContent === 'Clear history')!.click();
  await tick();
  expect(api.clearDatabaseIncidentHistory).toHaveBeenCalledWith('linkq-test');
});

it('loads diagnostics-worker server history and renders its sessions with the same blocking hierarchy', async () => {
  api.readDatabaseServerIncidentHistory = vi.fn(() => reply({
    connection: 'linkq-test',
    database: 'L80LINKQ.TEST',
    capturedAt: '2026-09-19T01:38:00.000Z',
    available: true,
    captures: [{
      captureId: 901,
      capturedAt: '2026-09-19T01:37:45.000Z',
      serverName: 'SQL-ERP-01',
      instanceName: 'MSSQLSERVER',
      blockingCount: 1,
      longRequestCount: 1,
      openTransactionCount: 1,
      sessions: [{
        captureId: 901,
        sessionId: 91,
        status: 'sleeping',
        command: 'idle',
        database: 'L80LINKQ.TEST',
        login: 'erp_user',
        host: 'ERP-APP-01',
        program: 'LinkQ ERP',
        elapsedMs: 0,
        cpuMs: 0,
        logicalReads: 0,
        writes: 0,
        waitType: null,
        lastWaitType: null,
        waitMs: 0,
        waitResource: null,
        blockingSessionId: 0,
        openTransactionCount: 1,
        transactionBeginTime: '2026-09-19T01:32:45.000Z',
        transactionAgeSeconds: 300,
        queryHash: null,
        queryPlanHash: null,
        isBlocked: false,
        isBlocker: true,
        isRootBlocker: true,
        isSleepingTransaction: true,
        reasonMask: 12,
        reasons: ['long-transaction', 'blocking-chain'],
        sql: 'UPDATE dbo.L09TDDMUNGVIEN SET Ten_UvTd = @name',
        runningStatement: null
      }, {
        captureId: 901,
        sessionId: 92,
        status: 'suspended',
        command: 'SELECT',
        database: 'L80LINKQ.TEST',
        login: 'report_user',
        host: 'REPORT-02',
        program: 'LinkQ Report',
        elapsedMs: 65000,
        cpuMs: 500,
        logicalReads: 2000,
        writes: 0,
        waitType: 'LCK_M_S',
        lastWaitType: 'LCK_M_S',
        waitMs: 62000,
        waitResource: 'PAGE: 7:1:12345',
        blockingSessionId: 91,
        openTransactionCount: 0,
        transactionBeginTime: null,
        transactionAgeSeconds: null,
        queryHash: '0x1234',
        queryPlanHash: '0x5678',
        isBlocked: true,
        isBlocker: false,
        isRootBlocker: false,
        isSleepingTransaction: false,
        reasonMask: 11,
        reasons: ['blocked', 'long-request', 'blocking-chain'],
        sql: 'SELECT * FROM dbo.L09TDDMUNGVIEN',
        runningStatement: 'SELECT Ma_UvTd, Ten_UvTd FROM dbo.L09TDDMUNGVIEN'
      }]
    }],
    limitations: [],
    elapsedMs: 4
  }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();

  const loadServer = [...document.querySelectorAll<HTMLButtonElement>('.database-investigator-actions .btn')]
    .find(node => node.textContent === 'Load server history')!;
  loadServer.click();
  await tick();

  expect(api.readDatabaseServerIncidentHistory).toHaveBeenCalledWith('linkq-test');
  const history = document.querySelector<HTMLElement>('.database-server-history')!;
  expect(history.textContent).toContain('#901');
  expect(history.textContent).toContain('SQL-ERP-01');
  expect(history.textContent).toContain('Blocked 1');
  const rootBlocker = history.querySelector<HTMLElement>('.database-blocking-node[data-session-id="91"]')!;
  const blocked = rootBlocker.querySelector<HTMLElement>('.database-blocking-node[data-session-id="92"]')!;
  expect(rootBlocker.textContent).toContain('Sleeping transaction');
  expect(blocked.textContent).toContain('PAGE: 7:1:12345');
  expect(blocked.textContent).toContain('Running statement');
  expect(blocked.textContent).toContain('SELECT Ma_UvTd, Ten_UvTd');
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
  baseline.value = JSON.stringify({ type: 'live', connection: 'linkq-2025' });
  current.value = JSON.stringify({ type: 'live', connection: 'linkq-test' });
  baselineDate.value = '2025-09-16';
  document.getElementById('databaseGrowthCompareRun')!.click();
  await tick();

  expect(api.compareDatabaseGrowth).toHaveBeenCalledWith({
    baseline: { type: 'live', connection: 'linkq-2025' },
    current: { type: 'live', connection: 'linkq-test' },
    baselineAsOf: '2025-09-16'
  });
  const comparison = document.getElementById('databaseGrowthCompareBody')!;
  expect(comparison.textContent).toContain('+20.0 GB');
  expect(comparison.textContent).toContain('79.4%');
  expect(comparison.textContent).toContain('dbo.L01BANKHISTORY');
  expect(comparison.textContent).toContain('+39,000,000');
  expect(comparison.textContent).toContain('Schema & index drift');
  expect(comparison.textContent).toContain('8 → 10 · changed');

  let aiPrompt = '';
  dom.window.addEventListener('cos:database-open-chat', event => {
    aiPrompt = (event as CustomEvent<{ suggestedText?: string }>).detail?.suggestedText ?? '';
  });
  document.getElementById('databaseGrowthCompareExplain')!.click();
  expect(aiPrompt).toContain('2025-09-16');
  expect(aiPrompt).toContain('data actually used');
  expect(aiPrompt).toContain('L01BANKHISTORY');
  expect(aiPrompt).toContain('matching tables with column/index drift: 1');
  expect(aiPrompt).toContain('Do not claim a historical cause');
});

it('offers saved snapshots as compare sources and can compare a snapshot with the live database', async () => {
  const snapshotId = '22222222-2222-4222-8222-222222222222';
  api.readDatabaseGrowthHistory!.mockImplementation((id: string) => reply({
    connection: id,
    snapshots: id === 'linkq-test' ? [{
      id: snapshotId,
      connection: 'linkq-test',
      savedAt: '2025-09-16T01:01:00.000Z',
      captureVersion: 2,
      database: 'L80LINKQ.TEST',
      capturedAt: '2025-09-16T01:00:00.000Z',
      summary: { totalMb: 5000, dataMb: 4000, logMb: 1000, dataUsedMb: 3500, logUsedMb: 100, logUsedPercent: 10, tableCount: 220 },
      files: [],
      tables: [],
      tablesTruncated: false,
      limitations: []
    }] : []
  }));

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();
  await tick();

  const baseline = document.getElementById('databaseGrowthCompareBaseline') as HTMLSelectElement;
  const current = document.getElementById('databaseGrowthCompareCurrent') as HTMLSelectElement;
  const baselineType = document.getElementById('databaseGrowthCompareBaselineType') as HTMLSelectElement;
  const currentType = document.getElementById('databaseGrowthCompareCurrentType') as HTMLSelectElement;
  expect([...baseline.options].some(option => option.textContent?.includes('Snapshot ·'))).toBe(true);
  expect(baseline.querySelector('optgroup')?.label).toBe('LinkQ Test');
  expect(baselineType.value).toBe('snapshot');
  expect(currentType.value).toBe('live');
  expect(JSON.parse(baseline.value)).toEqual({ type: 'snapshot', connection: 'linkq-test', snapshotId });
  expect(JSON.parse(current.value)).toEqual({ type: 'live', connection: 'linkq-test' });
  expect((document.getElementById('databaseGrowthCompareBaselineDateField') as HTMLElement).hidden).toBe(true);

  document.getElementById('databaseGrowthCompareRun')!.click();
  await tick();
  expect(api.compareDatabaseGrowth).toHaveBeenCalledWith({
    baseline: { type: 'snapshot', connection: 'linkq-test', snapshotId },
    current: { type: 'live', connection: 'linkq-test' }
  });
});

it('explains local snapshot storage and deletes a saved baseline from the dashboard', async () => {
  const snapshotId = '33333333-3333-4333-8333-333333333333';
  api.readDatabaseGrowthHistory!.mockImplementation((id: string) => reply({
    connection: id,
    snapshots: [{
      id: snapshotId,
      connection: id,
      savedAt: '2026-09-16T01:01:00.000Z',
      captureVersion: 2,
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-16T01:00:00.000Z',
      summary: { totalMb: 5000, dataMb: 4000, logMb: 1000, dataUsedMb: 3500, logUsedMb: 100, logUsedPercent: 10, tableCount: 220 },
      files: [], tables: [], tablesTruncated: false, tableFingerprints: [], schemaTruncated: false, limitations: []
    }]
  }));
  api.deleteDatabaseGrowthSnapshot!.mockImplementation((id: string, idToDelete: string) => {
    expect(idToDelete).toBe(snapshotId);
    return reply({ connection: id, snapshots: [] });
  });
  vi.spyOn(dom.window, 'confirm').mockReturnValue(true);

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();
  document.getElementById('databaseGrowthRefresh')!.click();
  await tick();
  await tick();

  const history = document.querySelector('.database-growth-history')!;
  expect(history.textContent).toContain('Stored locally in COS ERP DB app data');
  expect(history.textContent).toContain('1 snapshot · max 52');
  expect(history.textContent).toContain('Captured');
  expect(history.textContent).toContain('Saved');

  document.querySelector<HTMLButtonElement>('.database-growth-snapshot-delete')!.click();
  await tick();
  expect(api.deleteDatabaseGrowthSnapshot).toHaveBeenCalledWith('linkq-test', snapshotId);
  expect(document.querySelector('.database-growth-history')!.textContent).toContain('No baseline yet');
});

it('clears all local snapshots for the selected connection after confirmation', async () => {
  const snapshotId = '44444444-4444-4444-8444-444444444444';
  api.readDatabaseGrowthHistory!.mockImplementation((id: string) => reply({
    connection: id,
    snapshots: [{
      id: snapshotId,
      connection: id,
      savedAt: '2026-09-16T01:01:00.000Z',
      database: 'L80LINKQ.TEST',
      capturedAt: '2026-09-16T01:00:00.000Z',
      summary: { totalMb: 5000, dataMb: 4000, logMb: 1000, dataUsedMb: 3500, logUsedMb: 100, logUsedPercent: 10, tableCount: 220 }
    }]
  }));
  vi.spyOn(dom.window, 'confirm').mockReturnValue(true);

  const { initDatabaseSettings } = await import('../src/cos-erp-db/renderer/database-settings.js');
  initDatabaseSettings();
  await tick();
  document.getElementById('databaseGrowthRefresh')!.click();
  await tick();
  await tick();

  document.querySelector<HTMLButtonElement>('.database-growth-history-clear')!.click();
  await tick();
  expect(api.clearDatabaseGrowthHistory).toHaveBeenCalledWith('linkq-test');
  expect(document.querySelector('.database-growth-history')!.textContent).toContain('No baseline yet');
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





