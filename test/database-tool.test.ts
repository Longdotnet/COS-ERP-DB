import { expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerDatabaseTool } from '../src/cos-erp-db/mcp/database-tool.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

it('publishes a small credential-free database schema and returns structured query data', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let declaration: any;
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((name: string, config: any, handler: (args: any) => Promise<ToolResult>) => {
    if (name === 'database') {
      declaration = config;
      invoke = handler;
    }
  }) as typeof reg.register;
  const execute = vi.fn(async () => ({
    action: 'query' as const,
    connection: 'linkq-test',
    database: 'L80LINKQ.TEST',
    columns: [{ name: 'Ma_Zone', type: 'varchar', nullable: false }],
    rows: [{ Ma_Zone: 'Z01' }],
    rowCount: 1,
    elapsedMs: 18,
    truncated: false
  }));

  registerDatabaseTool(reg, execute);
  const schema = declaration.inputSchema;
  const json = JSON.stringify(schema);
  expect(json).toContain('action');
  expect(json).toContain('connection');
  expect(json).toContain('sql');
  expect(json).toContain('search_objects');
  expect(json).toContain('growth_diagnostics');
  expect(json).toContain('incident_workspace');
  expect(json).toContain('incident_diagnose');
  expect(json).toContain('incident_history');
  expect(json).toContain('workspace_context');
  expect(json).toContain('list_connections');
  expect(json).toContain('column_search');
  expect(json).toContain('source_trace');
  expect(json).toContain('incident_cause_trace');
  expect(json).toContain('query_store');
  expect(json).toContain('schema_compare');
  expect(json).toContain('health_gate');
  expect(json).toContain('deployment_fingerprint');
  expect(json).toContain('deployment_compare');
  expect(json).toContain('data_timeline');
  expect(json).toContain('scope');
  expect(json).toContain('symptom');
  expect(json).toContain('cursor');
  expect(json).not.toMatch(/password|server|user|domain/i);
  expect(declaration.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

  const result = await invoke({ action: 'query', connection: 'linkq-test', sql: 'SELECT TOP 10 * FROM dbo.L00ZONES' });
  expect(execute).toHaveBeenCalledWith({ action: 'query', connection: 'linkq-test', sql: 'SELECT TOP 10 * FROM dbo.L00ZONES' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    action: 'query', connection: 'linkq-test', database: 'L80LINKQ.TEST', rowCount: 1
  });
  expect(result.content[0]).toMatchObject({ type: 'text' });
  await server.close();
});

it('routes the existing read-only investigator through the single database MCP tool', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  const execute = vi.fn(async () => ({
    action: 'list_connections' as const,
    defaultConnectionId: 'linkq-test',
    connections: [{ id: 'linkq-test', name: 'LINKQ', database: 'L80LINKQ.TEST', accessMode: 'read-only' as const, isDefault: true }]
  }));
  const incident = {
    diagnose: vi.fn(),
    history: vi.fn(),
    serverHistory: vi.fn(),
    columnSearch: vi.fn(async () => ({
      connection: 'linkq-test', database: 'L80LINKQ.TEST', search: 'Tien', matches: [], truncated: false, elapsedMs: 2
    })),
    sourceTrace: vi.fn(async () => ({
      connection: 'linkq-test', database: 'L80LINKQ.TEST',
      source: { objectId: 42, schema: 'dbo', table: 'L10BANGLUONG', column: 'Tien' },
      sourceRoot: '/src-net10-1.0.0', searchedFiles: 10, skippedFiles: 0, matches: [], truncated: false,
      limitations: [], elapsedMs: 4
    })),
    queryStore: vi.fn(async () => ({
      connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: '2026-10-01T00:00:00.000Z',
      available: true, actualState: 'READ_WRITE', desiredState: 'READ_WRITE', readonlyReason: 0,
      currentStorageMb: 10, maxStorageMb: 1000, hours: 24, sort: 'reads' as const, queries: [], limitations: [], elapsedMs: 3
    })),
    schemaCompare: vi.fn(async () => ({
      baseline: { connection: 'base', database: 'BASE', capturedAt: '2026-10-01T00:00:00.000Z' },
      current: { connection: 'customer', database: 'CUSTOMER', capturedAt: '2026-10-01T00:00:00.000Z' },
      summary: {
        tablesAdded: 0, tablesRemoved: 0, columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0,
        indexesAdded: 0, indexesRemoved: 0, indexesChanged: 0, proceduresAdded: 0, proceduresRemoved: 0,
        proceduresChanged: 0, viewsAdded: 0, viewsRemoved: 0, viewsChanged: 0
      },
      differences: [], totalDifferenceCount: 0, truncated: false, limitations: [], elapsedMs: 5
    })),
    healthGate: vi.fn(async () => ({
      connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: '2026-10-01T00:00:00.000Z',
      status: 'healthy' as const, checks: [], limitations: [], elapsedMs: 6
    })),
    deploymentFingerprint: vi.fn(async () => ({
      connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: '2026-10-01T00:00:00.000Z',
      complete: true, fingerprint: 'f', schemaHash: 's', moduleHash: 'm', configurationHash: 'c',
      counts: { objects: 1, columns: 1, indexes: 1, constraints: 1, modules: 1 },
      configuration: {
        compatibilityLevel: 160, collation: 'SQL_Latin1_General_CP1_CI_AS', recoveryModel: 'FULL',
        readCommittedSnapshot: false, snapshotIsolationState: 'OFF'
      },
      limitations: [], elapsedMs: 7
    })),
    deploymentCompare: vi.fn(async () => ({
      baseline: {
        connection: 'base', database: 'BASE', capturedAt: '2026-10-01T00:00:00.000Z',
        complete: true, fingerprint: 'a', schemaHash: 's', moduleHash: 'm', configurationHash: 'c1',
        counts: { objects: 1, columns: 1, indexes: 1, constraints: 1, modules: 1 },
        configuration: {
          compatibilityLevel: 160, collation: 'SQL_Latin1_General_CP1_CI_AS', recoveryModel: 'FULL',
          readCommittedSnapshot: false, snapshotIsolationState: 'OFF'
        },
        limitations: [], elapsedMs: 5
      },
      current: {
        connection: 'customer', database: 'CUSTOMER', capturedAt: '2026-10-01T00:00:00.000Z',
        complete: true, fingerprint: 'b', schemaHash: 's', moduleHash: 'm', configurationHash: 'c2',
        counts: { objects: 1, columns: 1, indexes: 1, constraints: 1, modules: 1 },
        configuration: {
          compatibilityLevel: 150, collation: 'SQL_Latin1_General_CP1_CI_AS', recoveryModel: 'FULL',
          readCommittedSnapshot: false, snapshotIsolationState: 'OFF'
        },
        limitations: [], elapsedMs: 5
      },
      exactFingerprintMatch: false, schemaHashMatch: true, moduleHashMatch: true,
      configurationHashMatch: false,
      schema: {
        baseline: { connection: 'base', database: 'BASE', capturedAt: '2026-10-01T00:00:00.000Z' },
        current: { connection: 'customer', database: 'CUSTOMER', capturedAt: '2026-10-01T00:00:00.000Z' },
        summary: {
          tablesAdded: 0, tablesRemoved: 0, columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0,
          indexesAdded: 0, indexesRemoved: 0, indexesChanged: 0, proceduresAdded: 0, proceduresRemoved: 0,
          proceduresChanged: 0, viewsAdded: 0, viewsRemoved: 0, viewsChanged: 0
        },
        differences: [], totalDifferenceCount: 0, truncated: false, limitations: [], elapsedMs: 5
      },
      limitations: []
    })),
    dataTimeline: vi.fn(async () => ({
      connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: '2026-10-01T00:00:00.000Z',
      object: { objectId: 42, schema: 'dbo', table: 'L10BANGLUONG' },
      subject: { column: 'Ident00', value: '123' }, matchedRows: 1, ambiguous: false,
      current: [], events: [],
      sources: { createModifyLog: true, voucherHistory: false, genericHistoryAvailable: false, genericHistoryLinked: false as const },
      limitations: [], elapsedMs: 8
    }))
  };
  registerDatabaseTool(reg, execute, incident);

  const columns = await invoke({ action: 'column_search', search: 'Tien' });
  expect(execute).toHaveBeenCalledWith({ action: 'list_connections' });
  expect(incident.columnSearch).toHaveBeenCalledWith('linkq-test', 'Tien');
  expect(columns.structuredContent).toMatchObject({ action: 'column_search', database: 'L80LINKQ.TEST' });

  await invoke({ action: 'source_trace', objectId: 42, column: 'Tien', sourceRoot: '/src-net10-1.0.0' });
  expect(incident.sourceTrace).toHaveBeenCalledWith({
    connection: 'linkq-test', objectId: 42, column: 'Tien', sourceRoot: '/src-net10-1.0.0'
  });

  await invoke({ action: 'query_store', connection: 'linkq-test', hours: 24, sort: 'reads' });
  expect(incident.queryStore).toHaveBeenCalledWith({ connection: 'linkq-test', hours: 24, sort: 'reads' });

  await invoke({ action: 'schema_compare', baselineConnection: 'base', currentConnection: 'customer' });
  expect(incident.schemaCompare).toHaveBeenCalledWith({ baselineConnection: 'base', currentConnection: 'customer' });

  await invoke({ action: 'health_gate' });
  expect(incident.healthGate).toHaveBeenCalledWith('linkq-test');

  await invoke({ action: 'deployment_fingerprint', connection: 'linkq-test' });
  expect(incident.deploymentFingerprint).toHaveBeenCalledWith('linkq-test');

  await invoke({ action: 'deployment_compare', baselineConnection: 'base', currentConnection: 'customer' });
  expect(incident.deploymentCompare).toHaveBeenCalledWith({ baselineConnection: 'base', currentConnection: 'customer' });

  await invoke({ action: 'data_timeline', objectId: 42, subject: 'Ident00=123', limit: 25 });
  expect(incident.dataTimeline).toHaveBeenCalledWith({
    connection: 'linkq-test', objectId: 42, subject: 'Ident00=123', limit: 25
  });
  await server.close();
});

it('exposes bounded read-only incident diagnosis and local incident history to the model', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  const execute = vi.fn(async () => ({ action: 'test' as const, connection: 'unused', database: 'unused', ok: true as const, elapsedMs: 1 }));
  const snapshot = {
    id: '2a9e7e99-1f04-45aa-a690-f621b8ca742d',
    connection: 'linkq-test',
    database: 'L80LINKQ.TEST',
    capturedAt: '2026-09-19T01:30:00.000Z',
    savedAt: '2026-09-19T01:30:00.000Z',
    summary: { totalMb: 1000, dataUsedMb: 700, logUsedPercent: 20, activeRequestCount: 2, blockedRequestCount: 1, failedJobCount: 0 },
    requests: [], jobs: [], findings: [], limitations: []
  };
  const incident = {
    workspace: vi.fn(async () => ({
      scope: 'customer-a', symptom: 'salary wrong', requestedConnection: 'linkq-test', contextReadiness: 'grounded' as const,
      context: { readiness: 'grounded' },
      technical: { status: 'captured' as const, diagnosis: snapshot, health: null, deployment: null, errors: [] },
      rootCauseConfirmed: false as const,
      guidance: 'grounded'
    } as any)),
    diagnose: vi.fn(async () => snapshot as any),
    history: vi.fn(async () => ({ connection: 'linkq-test', snapshots: [snapshot, { ...snapshot, id: 'e263121d-d67d-4352-b061-8433f6319fa6' }] as any[] })),
    serverHistory: vi.fn(async () => ({ connection: 'linkq-test', database: 'L80LINKQ.TEST', capturedAt: snapshot.capturedAt, available: true, captures: [], limitations: [], elapsedMs: 2 }))
  };
  registerDatabaseTool(reg, execute, incident);

  const workspace = await invoke({ action: 'incident_workspace', scope: 'customer-a', symptom: 'salary wrong', connection: 'linkq-test' });
  expect(incident.workspace).toHaveBeenCalledWith(
    { scope: 'customer-a', symptom: 'salary wrong', connection: 'linkq-test' },
    []
  );
  expect(workspace.structuredContent).toMatchObject({
    action: 'incident_workspace', contextReadiness: 'grounded', rootCauseConfirmed: false
  });

  const live = await invoke({ action: 'incident_diagnose' });
  expect(incident.diagnose).toHaveBeenCalledWith(undefined);
  expect(execute).not.toHaveBeenCalled();
  expect(live.structuredContent).toMatchObject({
    action: 'incident_diagnose', connection: 'linkq-test', snapshot: { summary: { blockedRequestCount: 1 } }
  });

  const history = await invoke({ action: 'incident_history', connection: 'linkq-test', incidentLimit: 1 });
  expect(incident.history).toHaveBeenCalledWith('linkq-test');
  expect(incident.serverHistory).toHaveBeenCalledWith('linkq-test');
  expect((history.structuredContent as { snapshots: unknown[] }).snapshots).toHaveLength(1);
  expect(history.structuredContent).toMatchObject({ serverHistory: { available: true } });
  await server.close();
});

it('exposes fixed growth diagnostics to the model without model-authored SQL', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  const execute = vi.fn(async () => ({
    action: 'growth_diagnostics' as const,
    connection: 'linkq-test',
    database: 'L80LINKQ.TEST',
    capturedAt: '2026-09-15T17:00:00.000Z',
    summary: { totalMb: 2000, dataMb: 200, logMb: 1800, dataUsedMb: 150, logUsedMb: 1700, logUsedPercent: 94.4, tableCount: 100 },
    log: { available: true, stateAvailable: true, recoveryModel: 'FULL', reuseWait: 'LOG_BACKUP', totalMb: 1800, usedMb: 1700, freeMb: 100, usedPercent: 94.4, sinceLastBackupMb: 1600 },
    files: [],
    largestTables: [],
    tableStorageAvailable: true,
    findings: [],
    nextActions: [],
    limitations: [],
    historicalBaselineAvailable: false as const,
    elapsedMs: 5
  }));
  registerDatabaseTool(reg, execute);

  const result = await invoke({ action: 'growth_diagnostics', connection: 'linkq-test' });

  expect(execute).toHaveBeenCalledWith({ action: 'growth_diagnostics', connection: 'linkq-test' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    action: 'growth_diagnostics',
    connection: 'linkq-test',
    summary: { totalMb: 2000, logMb: 1800 }
  });
  await server.close();
});

it('returns authoritative credential-free connection/default metadata to the model', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  const execute = vi.fn(async () => ({
    action: 'list_connections' as const,
    defaultConnectionId: 'asuz',
    connections: [
      { id: 'asuz', name: 'ASUZ', database: 'L70CAFE_HOATAN', accessMode: 'read-only' as const, isDefault: true },
      { id: 'linkqtest', name: 'LINKQTEST', database: 'L80LINKQ.TEST', accessMode: 'read-only' as const, isDefault: false }
    ]
  }));
  registerDatabaseTool(reg, execute);

  const result = await invoke({ action: 'list_connections' });

  expect(execute).toHaveBeenCalledWith({ action: 'list_connections' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ action: 'list_connections', defaultConnectionId: 'asuz' });
  expect((result.structuredContent as { connections: unknown[] }).connections).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'asuz', isDefault: true })
  ]));
  expect(JSON.stringify(result.structuredContent)).not.toMatch(/password|server|user|domain/i);
  await server.close();
});

it('returns the current Database Workspace context without requiring a connection or credentials', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  const execute = vi.fn(async () => ({
    action: 'workspace_context' as const,
    context: {
      connection: 'linkq-test',
      object: { objectId: 42, schema: 'dbo', name: 'L00ZONES', type: 'table' as const },
      tab: 'data' as const,
      page: 1,
      selectedRows: [{ Zone: 'A' }],
      selectedRowsTruncated: false,
      updatedAt: 1
    }
  }));
  registerDatabaseTool(reg, execute);

  const result = await invoke({ action: 'workspace_context' });

  expect(execute).toHaveBeenCalledWith({ action: 'workspace_context' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    action: 'workspace_context',
    context: { connection: 'linkq-test', object: { name: 'L00ZONES' }, selectedRows: [{ Zone: 'A' }] }
  });
  await server.close();
});

it('accepts bounded object-catalog search without requiring raw SQL', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  const execute = vi.fn(async () => ({
    action: 'search_objects' as const,
    connection: 'linkq-test',
    database: 'L80LINKQ.TEST',
    objects: [{ schema: 'dbo', name: 'L00ZONES', type: 'table' as const, objectId: 42, modifiedAt: null }],
    hasMore: false,
    elapsedMs: 3
  }));
  registerDatabaseTool(reg, execute);

  const result = await invoke({ action: 'search_objects', search: 'L00', types: ['table'], limit: 20 });

  expect(execute).toHaveBeenCalledWith({ action: 'search_objects', search: 'L00', types: ['table'], limit: 20 });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ action: 'search_objects', objects: [{ name: 'L00ZONES' }] });
  await server.close();
});

it('turns service failures into a model-facing tool error', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any) => Promise<ToolResult>) => { invoke = handler; }) as typeof reg.register;
  registerDatabaseTool(reg, async () => { throw new Error('DATABASE_NOT_CONFIGURED'); });
  const result = await invoke({ action: 'test' });
  expect(result.isError).toBe(true);
  expect((result.content[0] as { type: 'text'; text: string }).text).toContain('DATABASE_NOT_CONFIGURED');
  await server.close();
});

it('forwards the MCP cancellation signal to the database executor', async () => {
  const server = new McpServer({ name: 'database fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false
  }, 'core');
  let invoke!: (args: any, context?: { signal?: AbortSignal }) => Promise<ToolResult>;
  reg.register = ((_name: string, _config: any, handler: (args: any, context?: { signal?: AbortSignal }) => Promise<ToolResult>) => {
    invoke = handler;
  }) as typeof reg.register;
  const execute = vi.fn(async () => ({ action: 'test' as const, connection: 'linkq-test', database: 'L80LINKQ.TEST', ok: true as const, elapsedMs: 1 }));
  registerDatabaseTool(reg, execute);
  const controller = new AbortController();

  await invoke({ action: 'test' }, { signal: controller.signal });

  expect(execute).toHaveBeenCalledWith({ action: 'test' }, { signal: controller.signal });
  await server.close();
});
