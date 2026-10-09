import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerEngineeringTool } from '../src/cos-erp-db/mcp/engineering-tool.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

it('publishes a compact project-native engineering surface and serves profiles without project state', async () => {
  const server = new McpServer({ name: 'engineering fixture', version: '1' });
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

  registerEngineeringTool(reg);

  const schema = JSON.stringify(declaration.inputSchema);
  expect(schema).toContain('profile_get');
  expect(schema).toContain('prepare');
  expect(schema).toContain('discover');
  expect(schema).toContain('task_put');
  expect(schema).toContain('convention_put');
  expect(schema).toContain('validation_run');
  expect(schema).toContain('validation_get');
  expect(schema).toContain('performance_get');
  expect(schema).toContain('quality_gate');
  expect(declaration.annotations).toMatchObject({ destructiveHint: false });

  const reply = await invoke({ action: 'profile_get', profile: 'linkq' });
  expect(reply.structuredContent).toMatchObject({
    id: 'linkq',
    title: 'LINKQ Engineering',
    analogueTarget: { min: 3, max: 7 }
  });

  const custom = await invoke({ action: 'profile_get', profile: 'thaiviet' });
  expect(custom.structuredContent).toMatchObject({
    id: 'generic',
    analogueTarget: { min: 3, max: 7 }
  });

  expect(declaration.inputSchema.safeParse({ action: 'discover', query: 'frmEdit', limit: 2 }).success).toBe(false);
  expect(declaration.inputSchema.safeParse({ action: 'prepare' }).success).toBe(false);
  expect(declaration.inputSchema.safeParse({ action: 'validation_run' }).success).toBe(false);
  expect(declaration.inputSchema.safeParse({ action: 'task_put' }).success).toBe(false);
  expect(declaration.inputSchema.safeParse({ action: 'quality_gate', items: ['task-a', 'task-b'] }).success).toBe(false);
  expect(declaration.inputSchema.safeParse({ action: 'performance_get', items: ['task-a', 'task-b'] }).success).toBe(false);

  await server.close();
});
