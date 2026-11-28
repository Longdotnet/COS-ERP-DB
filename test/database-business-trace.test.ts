import { expect, it, vi } from 'vitest';
import { investigateBusinessObject } from '../src/cos-erp-db/investigation/business-trace.js';
import { assertReadOnlySql, type DatabaseActionInput, type DatabaseQueryOutput } from '../src/main/database/service.js';

function fixture(handler: (sql: string) => Record<string, unknown>[]) {
  return vi.fn(async (input: DatabaseActionInput): Promise<DatabaseQueryOutput> => {
    if (input.action !== 'query') throw new Error('unexpected action');
    assertReadOnlySql(input.sql);
    expect(input.connection).toBe('noibo');
    const rows = handler(input.sql);
    return { action: 'query', connection: 'noibo', database: 'L70NOIBO', columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated: false };
  });
}
const catalog = (table: string, columns: string[]) => columns.map(ColumnName => ({ TableName: table, ColumnName }));

it('traces CHAMCONG07 through report metadata into the live procedure and its direct dependency', async () => {
  const execute = fixture(sql => {
    if (sql.includes('FROM sys.tables')) return catalog('L00REPORT', ['Report_Id', 'SqlProc', 'Is_App']);
    if (sql.includes('FROM dbo.[L00REPORT]')) return [{ Report_Id: 'CHAMCONG07', SqlProc: 'sp_rptChamCongNgay', Is_App: true }];
    if (sql.includes('FROM sys.objects')) {
      expect(sql).toContain("N'sp_rptChamCongNgay'");
      return [{ ObjectId: 42, Schema: 'dbo', Name: 'sp_rptChamCongNgay', Type: 'SQL_STORED_PROCEDURE' }];
    }
    if (sql.includes('FROM sys.sql_expression_dependencies')) return [{ FromName: 'sp_rptChamCongNgay', ToName: 'L10CHAMCONG', ToObjectId: 43 }];
    throw new Error(sql);
  });
  const result = await investigateBusinessObject({ connection: 'noibo', search: 'CHAMCONG07' }, execute);
  expect(result.metadata).toEqual([{ table: 'L00REPORT', rows: [{ Report_Id: 'CHAMCONG07', SqlProc: 'sp_rptChamCongNgay', Is_App: true }], truncated: false }]);
  expect(result.objects[0]?.Name).toBe('sp_rptChamCongNgay');
  expect(result.dependencies[0]?.ToName).toBe('L10CHAMCONG');
  expect(result.unavailable).toContain('L00DMTABLE');
  expect(result.evidenceQueries).toHaveLength(4);
});

it('checks the configured lookup columns against the target table, not similarly named columns', async () => {
  const execute = fixture(sql => {
    if (sql.includes('FROM sys.tables')) return catalog('L00LOOKUP', ['ColumnID', 'Table_Lookup', 'ColumnID_Lookup', 'ColumnName_Lookup']);
    if (sql.includes('FROM dbo.[L00LOOKUP]')) return [{ ColumnID: 'MA_LOAIHD', Table_Lookup: 'L08DMLOAIHD', ColumnID_Lookup: 'MA_LOAIHD', ColumnName_Lookup: 'TEN_LOAIHD' }];
    if (sql.includes('FROM sys.objects')) return [{ ObjectId: 42, Schema: 'dbo', Name: 'L08DMLOAIHD', Type: 'USER_TABLE' }];
    if (sql.includes('FROM sys.sql_expression_dependencies')) return [];
    if (sql.includes('FROM sys.columns')) {
      expect(sql).toContain('c.object_id=42');
      return sql.includes("N'MA_LOAIHD'") ? [{ ColumnName: 'MA_LOAIHD', Type: 'varchar' }] : [];
    }
    throw new Error(sql);
  });
  const result = await investigateBusinessObject({ connection: 'noibo', search: 'MA_LOAIHD' }, execute);
  expect(result.lookupChecks).toMatchObject([
    { role: 'key', status: 'present', column: 'MA_LOAIHD' },
    { role: 'display', status: 'not-visible-in-catalog', column: 'TEN_LOAIHD' }
  ]);
});

it('never uses arbitrary parameter values, preserves literal search and reports clipped rows', async () => {
  const search = "x'; DROP TABLE a;--";
  const execute = fixture(sql => {
    if (sql.includes('FROM sys.tables')) return catalog('L00PARAMETERS', ['Parameter_ID', 'Parameter_Value', 'Module_ID']);
    expect(sql).toContain("N'x''; DROP TABLE a;--'");
    expect(sql).not.toContain('[Parameter_Value]');
    return Array.from({ length: 9 }, (_, i) => ({ Parameter_ID: search, Module_ID: String(i) }));
  });
  const result = await investigateBusinessObject({ connection: 'noibo', search }, execute);
  expect(result.metadata[0]?.rows).toHaveLength(8);
  expect(result.truncated).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
});

it('does not guess a connection or combine evidence from a changing database', async () => {
  const execute = fixture(() => []);
  await expect(investigateBusinessObject({ connection: '', search: 'sp_GetHopDong' }, execute)).rejects.toThrow('Explicit connection');
  expect(execute).not.toHaveBeenCalled();
  const moved = vi.fn(async (input: DatabaseActionInput) => {
    const result = await execute(input);
    return { ...result, database: moved.mock.calls.length === 1 ? 'A' : 'B' };
  });
  await expect(investigateBusinessObject({ connection: 'noibo', search: 'sp_GetHopDong' }, moved)).rejects.toThrow('identity changed');
});
