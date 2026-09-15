import { afterEach, describe, expect, it } from 'vitest';
import {
  getDatabaseWorkspaceContext,
  MAX_DATABASE_CONTEXT_SELECTED_ROWS,
  resetDatabaseWorkspaceContextForTests,
  setDatabaseWorkspaceContext
} from '../src/main/database/workspace-context.js';

afterEach(() => resetDatabaseWorkspaceContextForTests());

describe('database workspace context', () => {
  it('stays in memory and bounds selected rows and large cell values', () => {
    const rows = Array.from({ length: MAX_DATABASE_CONTEXT_SELECTED_ROWS + 3 }, (_, index) => ({
      id: index,
      note: 'x'.repeat(5_000)
    }));
    const context = setDatabaseWorkspaceContext({
      connection: 'linkq-test',
      object: { objectId: 42, schema: 'dbo', name: 'L00ZONES', type: 'table' },
      tab: 'data',
      page: 2,
      selectedRows: rows
    });

    expect(context?.selectedRows).toHaveLength(MAX_DATABASE_CONTEXT_SELECTED_ROWS);
    expect(context?.selectedRowsTruncated).toBe(true);
    expect(String(context?.selectedRows?.[0]?.note).length).toBeLessThanOrEqual(4_001);
    expect(getDatabaseWorkspaceContext()).toEqual(context);
  });

  it('clears the snapshot without persisting a placeholder', () => {
    setDatabaseWorkspaceContext({ connection: 'linkq-test' });
    expect(getDatabaseWorkspaceContext()).not.toBeNull();
    expect(setDatabaseWorkspaceContext(null)).toBeNull();
    expect(getDatabaseWorkspaceContext()).toBeNull();
  });
});
