import { expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerKnowledgeTool } from '../src/cos-erp-db/mcp/knowledge-tool.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

it('publishes one provenance-aware knowledge primitive and routes evidence plus process actions', async () => {
  const server = new McpServer({ name: 'knowledge fixture', version: '1' });
  const reg = createRegistrar(server, {
    roots: [{ name: 'workspace', path: 'C:\\unused' }],
    caps: { ...DEFAULT_CAPABILITIES, read: true, edit: true },
    exposedCaps: { ...DEFAULT_CAPABILITIES, read: true, edit: true },
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }, 'core');
  let declaration: any;
  let invoke!: (args: any) => Promise<ToolResult>;
  reg.register = ((_name: string, config: any, handler: (args: any) => Promise<ToolResult>) => {
    declaration = config;
    invoke = handler;
  }) as typeof reg.register;

  const executor = {
    index: vi.fn(async () => ({ scope: 'erp', generation: 'g1' })),
    search: vi.fn(async () => ({ scope: 'erp', generation: 'g1', hits: [] })),
    get: vi.fn(async () => ({ scope: 'erp', generation: 'g1', evidence: [] })),
    verify: vi.fn(async () => ({ scope: 'erp', generation: 'g1', allCurrent: true })),
    processPut: vi.fn(async () => ({ scope: 'erp', changed: true })),
    processSearch: vi.fn(async () => ({ scope: 'erp', hits: [] })),
    processGet: vi.fn(async () => ({ scope: 'erp', records: [] })),
    processHistory: vi.fn(async () => ({ scope: 'erp', revisions: [] })),
    graphSearch: vi.fn(async () => ({ scope: 'erp', hits: [] })),
    graphExpand: vi.fn(async () => ({ scope: 'erp', nodes: [] })),
    incidentContext: vi.fn(async () => ({ scope: 'erp', readiness: 'grounded' })),
    outcomePut: vi.fn(async () => ({ scope: 'erp', changed: true, outcome: { key: 'outcome-1' } })),
    outcomeSearch: vi.fn(async () => ({ scope: 'erp', hits: [] })),
    outcomeGet: vi.fn(async () => ({ scope: 'erp', outcomes: [] })),
    outcomeHistory: vi.fn(async () => ({ scope: 'erp', key: 'outcome-1', revisions: [] })),
    patternPut: vi.fn(async () => ({ changed: true, pattern: { key: 'double-adjustment' } })),
    patternSearch: vi.fn(async () => ({ requestingScope: 'erp', hits: [] })),
    patternGet: vi.fn(async () => ({ requestingScope: 'erp', patterns: [] })),
    patternHistory: vi.fn(async () => ({ key: 'double-adjustment', revisions: [] }))
  };
  registerKnowledgeTool(reg, executor);

  const schema = JSON.stringify(declaration.inputSchema);
  expect(schema).toContain('index');
  expect(schema).toContain('search');
  expect(schema).toContain('get');
  expect(schema).toContain('verify');
  expect(schema).toContain('process_put');
  expect(schema).toContain('process_search');
  expect(schema).toContain('graph_search');
  expect(schema).toContain('graph_expand');
  expect(schema).toContain('incident_context');
  expect(schema).toContain('outcome_put');
  expect(schema).toContain('outcome_search');
  expect(schema).toContain('outcome_get');
  expect(schema).toContain('outcome_history');
  expect(schema).toContain('pattern_put');
  expect(schema).toContain('pattern_search');
  expect(schema).toContain('pattern_get');
  expect(schema).toContain('pattern_history');
  expect(declaration.annotations).toMatchObject({ destructiveHint: false });

  await invoke({
    action: 'index',
    scope: 'erp',
    items: ['source:/workspace/src'],
    mode: 'incremental'
  });
  expect(executor.index).toHaveBeenCalledWith({
    scope: 'erp',
    sources: [{ kind: 'source', path: '/workspace/src' }],
    mode: 'incremental'
  }, reg.ctx.roots);

  await invoke({ action: 'search', scope: 'erp', query: 'payroll', kinds: ['source'], limit: 5 });
  expect(executor.search).toHaveBeenCalledWith({ scope: 'erp', query: 'payroll', kinds: ['source'], limit: 5 });

  const id = 'a'.repeat(64);
  await invoke({ action: 'get', scope: 'erp', items: [id] });
  expect(executor.get).toHaveBeenCalledWith('erp', [id]);

  await invoke({ action: 'verify', scope: 'erp', items: [id + '@' + 'b'.repeat(64)] });
  expect(executor.verify).toHaveBeenCalledWith({
    scope: 'erp',
    evidence: [{ evidenceId: id, contentHash: 'b'.repeat(64) }]
  }, reg.ctx.roots);

  const process = { key: 'payroll', kind: 'process', title: 'Payroll', statement: 'Monthly payroll' };
  await invoke({ action: 'process_put', scope: 'erp', items: [JSON.stringify(process)] });
  expect(executor.processPut).toHaveBeenCalledWith('erp', process);

  await invoke({ action: 'process_search', scope: 'erp', query: 'payroll', limit: 3 });
  expect(executor.processSearch).toHaveBeenCalledWith('erp', 'payroll', 3);

  await invoke({ action: 'process_get', scope: 'erp', items: ['payroll'] });
  expect(executor.processGet).toHaveBeenCalledWith('erp', ['payroll']);

  await invoke({ action: 'process_history', scope: 'erp', items: ['payroll'] });
  expect(executor.processHistory).toHaveBeenCalledWith('erp', 'payroll');

  await invoke({ action: 'graph_search', scope: 'erp', query: 'frmBangLuong', limit: 5 });
  expect(executor.graphSearch).toHaveBeenCalledWith('erp', 'frmBangLuong', 5);

  await invoke({ action: 'graph_expand', scope: 'erp', items: ['record:abc'] });
  expect(executor.graphExpand).toHaveBeenCalledWith('erp', 'record:abc');
  await invoke({ action: 'incident_context', scope: 'erp', query: 'salary mismatch', limit: 4 });
  expect(executor.incidentContext).toHaveBeenCalledWith({
    scope: 'erp', query: 'salary mismatch', limit: 4
  }, reg.ctx.roots);

  const oversizedContext = declaration.inputSchema.safeParse({
    action: 'incident_context', scope: 'erp', query: 'salary mismatch', limit: 21
  });
  expect(oversizedContext.success).toBe(false);

  const pattern = {
    key: 'double-adjustment',
    title: 'Adjustment applied twice',
    symptom: 'Net salary differs after adjustment.',
    finding: 'The adjustment can be included twice in final calculation.',
    recommendedChecks: ['Trace the final salary formula.'],
    occurrence: {
      outcomeKey: 'outcome-1'
    }
  };

  const outcome = {
    key: 'outcome-1',
    incidentKey: 'INC-1',
    title: 'Confirmed salary incident',
    symptom: 'Net salary differs after adjustment.',
    processKey: 'process:payroll',
    expectedBehaviorKey: 'expected:net',
    rootCauseCategory: 'calculation-path',
    finding: 'The adjustment was included twice.',
    remediation: 'Remove the duplicate inclusion.',
    evidence: [{ evidenceId: id, contentHash: 'b'.repeat(64), relation: 'supports' }],
    validation: {
      result: 'passed',
      summary: 'Recalculation applies it once.',
      evidence: [{ evidenceId: id, contentHash: 'b'.repeat(64), relation: 'supports' }]
    },
    status: 'accepted',
    decisionNote: 'Reviewed and accepted.'
  };
  await invoke({ action: 'outcome_put', scope: 'erp', items: [JSON.stringify(outcome)] });
  expect(executor.outcomePut).toHaveBeenCalledWith('erp', outcome);

  await invoke({ action: 'outcome_search', scope: 'erp', query: 'salary', limit: 4 });
  expect(executor.outcomeSearch).toHaveBeenCalledWith('erp', 'salary', 4);

  await invoke({ action: 'outcome_get', scope: 'erp', items: ['outcome-1'] });
  expect(executor.outcomeGet).toHaveBeenCalledWith('erp', ['outcome-1']);

  await invoke({ action: 'outcome_history', scope: 'erp', items: ['outcome-1'] });
  expect(executor.outcomeHistory).toHaveBeenCalledWith('erp', 'outcome-1');

  await invoke({ action: 'pattern_put', scope: 'erp', items: [JSON.stringify(pattern)] });
  expect(executor.patternPut).toHaveBeenCalledWith('erp', pattern);

  await invoke({ action: 'pattern_search', scope: 'erp', query: 'net salary', limit: 4 });
  expect(executor.patternSearch).toHaveBeenCalledWith('erp', 'net salary', 4);

  await invoke({ action: 'pattern_get', scope: 'erp', items: ['double-adjustment'] });
  expect(executor.patternGet).toHaveBeenCalledWith('erp', ['double-adjustment']);

  await invoke({ action: 'pattern_history', scope: 'erp', items: ['double-adjustment'] });
  expect(executor.patternHistory).toHaveBeenCalledWith('double-adjustment');
  await server.close();
});
