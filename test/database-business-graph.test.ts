import { expect, it, vi } from 'vitest';
import { investigateBusinessObject } from '../src/cos-erp-db/investigation/business-trace.js';
import { assertReadOnlySql, type DatabaseActionInput, type DatabaseQueryOutput } from '../src/main/database/service.js';

const report = { Report_Id: 'CHAMCONG07', SqlProc: 'sp_rptChamCongNgay', Object_ID: 'OBJ_REPORT' };
const form = { Form_ID: 'CHAMCONG07', Column_ID: 'MA_NV' };
const lookup = { ColumnID: 'MA_NV', Table_Lookup: 'L81DMNV', ColumnID_Lookup: 'MA_NV', ColumnName_Lookup: 'TEN_NV' };
const proc = { ObjectId: 1, Schema: 'dbo', Name: 'sp_rptChamCongNgay', Type: 'SQL_STORED_PROCEDURE' };
const second = { ObjectId: 2, Schema: 'dbo', Name: 'sp_inner', Type: 'SQL_STORED_PROCEDURE' };
const table = { ObjectId: 3, Schema: 'dbo', Name: 'L10CHAMCONG', Type: 'USER_TABLE' };
const dep = (from: typeof proc, to: typeof proc) => ({
  FromObjectId: from.ObjectId, FromName: from.Name, FromSchema: from.Schema, FromType: from.Type,
  ToObjectId: to.ObjectId, ToName: to.Name, ToSchema: to.Schema, ToType: to.Type, ToDatabase: null, ToServer: null, Ambiguous: false
});
it('follows explicit metadata joins and two SQL hops without walking reverse consumers through every shared table', async () => {
  const execute = vi.fn(async (input: DatabaseActionInput): Promise<DatabaseQueryOutput> => {
    if (input.action !== 'query') throw new Error('unexpected action');
    const sql = assertReadOnlySql(input.sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM sys.tables')) {
      rows = Object.entries({
        L00REPORT: ['Report_Id','SqlProc','Object_ID'],
        L00FormLayout: ['Form_ID','Column_ID'],
        L00LOOKUP: ['ColumnID','Table_Lookup','ColumnID_Lookup','ColumnName_Lookup'],
        L00OBJECT: ['Object_ID']
      }).flatMap(([TableName, cols]) => cols.map(ColumnName => ({ TableName, ColumnName })));
    } else if (sql.includes('FROM dbo.[L00REPORT]')) rows = [report];
    else if (sql.includes('FROM dbo.[L00FormLayout]')) rows = [form];
    else if (sql.includes('FROM dbo.[L00LOOKUP]') && sql.includes("N'MA_NV'")) rows = [lookup];
    else if (sql.includes('FROM dbo.[L00OBJECT]') && sql.includes("N'OBJ_REPORT'")) rows = [{ Object_ID: 'OBJ_REPORT' }];
    else if (sql.includes('FROM sys.objects')) rows = [proc, ...(sql.includes("N'L81DMNV'") ? [{ ObjectId: 4, Schema: 'dbo', Name: 'L81DMNV', Type: 'USER_TABLE' }] : [])];
    else if (sql.includes('FROM sys.sql_expression_dependencies')) {
      if (sql.includes('d.referencing_id IN (2)')) {
        expect(sql).not.toContain(' OR d.referenced_id');
        rows = [dep(second,table)];
      } else rows = [dep(proc,second)];
    } else if (sql.includes('KeyBytes')) rows = [{ TableId: 44, KeyBytes: 25 }];
    else if (sql.includes('FROM dbo.L00PERMISSION')) rows = [{ Object_ID: 'OBJ_REPORT', RuleCount: '2' }];
    return { action: 'query', connection: 'noibo', database: 'L70NOIBO', columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated: false };
  });
  const result = await investigateBusinessObject({ connection: 'noibo', search: 'CHAMCONG07', graphDepth: 3 },execute);
  const graph = result.graph!;
  const reportNode = graph.nodes.find(n => n.label.startsWith('L00REPORT:'))!;
  const formNode = graph.nodes.find(n => n.label.startsWith('L00FormLayout:'))!;
  const lookupNode = graph.nodes.find(n => n.label.startsWith('L00LOOKUP:'))!;
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: reportNode.id, to: formNode.id, relation: 'metadata-reference' }),
    expect.objectContaining({ from: formNode.id, to: lookupNode.id, relation: 'lookup-candidate' }),
    expect.objectContaining({ from: reportNode.id, to: 'sql:1', relation: 'sql-reference' }),
    expect.objectContaining({ from: 'sql:1', to: 'sql:2', relation: 'sql-dependency' }),
    expect.objectContaining({ from: 'sql:2', to: 'sql:3', relation: 'sql-dependency' }),
    expect.objectContaining({ from: reportNode.id, to: 'permission:OBJ_REPORT', relation: 'permission-config' })
  ]));
  expect(graph.nodes.find(n => n.id === 'permission:OBJ_REPORT')?.evidence).toEqual({ Object_ID: 'OBJ_REPORT', RuleCount: '2' });
  expect(graph.edges.every(e => graph.nodes.some(n => n.id === e.from) && graph.nodes.some(n => n.id === e.to))).toBe(true);
  expect(execute.mock.calls.length).toBeLessThan(30);
});
