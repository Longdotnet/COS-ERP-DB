import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import * as agents from '../src/main/agents.js';
import * as config from '../src/main/config.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import * as projects from '../src/main/projects.js';
import * as sessions from '../src/main/session/store.js';
import * as worktrees from '../src/main/worktrees/index.js';
import { resolveEngineeringLineage } from '../src/cos-erp-db/engineering/lineage.js';

afterEach(() => vi.restoreAllMocks());

it('keeps project metadata but resolves Engineering against the verified managed worker checkout', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-engineering-worktree-'));
  try {
    const source = path.join(temp, 'source');
    const checkout = path.join(temp, '.cos-erp-db-worktrees', 'owned', 'tree');
    await fs.mkdir(path.join(source, '.agents'), { recursive: true });
    await fs.mkdir(path.join(checkout, '.agents'), { recursive: true });
    await fs.writeFile(path.join(source, '.agents', 'engineering.json'), JSON.stringify({ profile: 'generic' }), 'utf8');
    await fs.writeFile(path.join(checkout, '.agents', 'engineering.json'), JSON.stringify({ profile: 'linkq' }), 'utf8');

    const allocation = { runId: '11111111-1111-4111-8111-111111111111', agentId: 'worker-1' };
    const lease = {
      ...allocation,
      workspace: { real: checkout, virtual: '/approved/.cos-erp-db-worktrees/owned/tree' }
    } as unknown as worktrees.WorkerWorktreeLease;

    vi.spyOn(agents, 'managedWorkerIsolationRequired').mockReturnValue(true);
    vi.spyOn(agents, 'managedWorkerAllocationIdentity').mockReturnValue(allocation);
    vi.spyOn(worktrees, 'lookupWorkerWorkspace').mockReturnValue(lease);
    const validate = vi.spyOn(worktrees, 'validateWorkerWorkspaceLease').mockResolvedValue(lease);
    vi.spyOn(config, 'getConfig').mockReturnValue({ roots: [{ name: 'approved', path: temp }] } as ReturnType<typeof config.getConfig>);
    vi.spyOn(sessions, 'getSession').mockResolvedValue({ projectId: 'project-1' } as Awaited<ReturnType<typeof sessions.getSession>>);
    vi.spyOn(projects, 'getProject').mockResolvedValue({ id: 'project-1' } as Awaited<ReturnType<typeof projects.getProject>>);
    const sourceWorkspace = vi.spyOn(projects, 'projectWorkspace').mockResolvedValue({ real: source, virtual: '/approved/source' });

    const call: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: 'worker-1',
      caller: { transportKey: null, requestId: 'request-1', conversationId: 'worker-chat', sessionId: 'session-1' },
      outcome: null,
      evidence: emptyEvidence()
    };
    const resolved = await runInCallContext(call, () => resolveEngineeringLineage());

    expect(resolved.workspace).toEqual({ real: checkout, virtual: '/approved/.cos-erp-db-worktrees/owned/tree' });
    expect(resolved.lineage).toMatchObject({ projectId: 'project-1', profile: 'linkq' });
    expect(validate).toHaveBeenCalledWith(lease, [{ name: 'approved', path: temp }]);
    expect(sourceWorkspace).not.toHaveBeenCalled();
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
