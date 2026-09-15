import { expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerDatabaseTool } from '../src/main/mcp/database-tool.js';
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
  expect(json).toContain('workspace_context');
  expect(json).toContain('list_connections');
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
