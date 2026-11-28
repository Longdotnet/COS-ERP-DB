import type { DatabaseActionInput, DatabaseActionOutput, DatabaseQueryOutput } from '../../main/database/service.js';
import { traceApplicationObjectTerms } from './source-trace.js';
import { expandBusinessGraph } from './business-graph.js';

type Execute = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
type Row = Record<string, unknown>;

// Only business identifiers and routing metadata, never arbitrary configuration values.
const metadata = [
  { table: 'L00REPORT', keys: ['Report_Id', 'Object_ID', 'SqlProc', 'Report_Name'], fields: ['Report_Parent', 'Report_ID_Filter', 'Is_App', 'Show_Mobile'], links: ['SqlProc'] },
  { table: 'L00DMTABLE', keys: ['Table_Name', 'Table_Name0', 'View_Table', 'Object_ID', 'Form_Id', 'Zone', 'Proc_Filter', 'Description'], fields: ['Table_Cha', 'ColumnID', 'ColumnName', 'ColumnID_Frg'], links: ['Table_Name0', 'View_Table', 'Table_Cha', 'Proc_Filter'] },
  { table: 'L00LOOKUP', keys: ['ColumnID', 'Table_Lookup', 'ColumnID_Lookup', 'ColumnName_Lookup', 'Zone'], fields: ['Table_Alias'], links: ['Table_Lookup'] },
  { table: 'L00FormConfig', keys: ['Form_ID'], fields: [], links: [] },
  { table: 'L00FormLayout', keys: ['Form_ID', 'Column_ID', 'ControlName', 'Table_Lookup', 'Column_Lookup'], fields: ['Visible', 'ReadOnly', 'Enabled'], links: ['Table_Lookup'] },
  { table: 'L00COLUMNS', keys: ['Zone', 'Column_ID'], fields: ['Visible', 'Language_Id', 'Description'], links: [] },
  { table: 'L00MENU', keys: ['Object_ID', 'Table_Name', 'Menu_Name', 'Menu_Method'], fields: ['Menu_Id', 'Menu_Parent', 'Show_Mobile'], links: [] },
  { table: 'L00OBJECT', keys: ['Object_ID', 'Object_Name'], fields: ['Object_Type', 'OBJECT_ID_PARENT'], links: [] },
  { table: 'L00DMCT', keys: ['Ma_Ct', 'Object_ID', 'Table_Ph', 'Table_Ct', 'sp_UpdatePh', 'sp_UpdateCt', 'Ten_Ct'], fields: ['Zone_ViewPh', 'Zone_ViewCt'], links: ['Table_Ph', 'Table_Ct', 'sp_UpdatePh', 'sp_UpdateCt'] },
  { table: 'L00PARAMETERS', keys: ['Parameter_ID'], fields: ['Module_ID', 'Visible'], links: [] }
] as const;

const literal = (value: string) => "N'" + value.replace(/'/g, "''") + "'";
const ident = (value: string) => '[' + value.replace(/]/g, ']]') + ']';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const distinct = (values: string[]) => [...new Set(values.filter(Boolean))];
const sqlName = (value: string) => /^[\p{L}\p{N}_$#]+(?:\.[\p{L}\p{N}_$#]+)?$/u.test(value);
const MAX_METADATA_ROWS = 8;
const MAX_OBJECTS = 20;
const MAX_DEPENDENCIES = 60;

export async function investigateBusinessObject(
  request: { connection: string; search: string; sourceRoot?: string; graphDepth?: number },
  execute: Execute,
  signal?: AbortSignal
) {
  const started = Date.now();
  const term = request.search.trim();
  if (!term || !request.connection) throw new Error('Explicit connection and a business identifier are required.');
  if (request.graphDepth !== undefined && (!Number.isInteger(request.graphDepth) || request.graphDepth < 1 || request.graphDepth > 4)) {
    throw new Error('Graph depth must be between 1 and 4.');
  }
  const limitations: string[] = [
    'Exact identifier matches only; labels are exact under the database collation.',
    'Catalog dependencies are direct; dynamic SQL, synonyms and external references may require separate investigation.',
    'Metadata records are configuration evidence, not proof of runtime authorization or execution.'
  ];
  let database = '';
  let connection = '';
  let truncated = false;
  const queries: Array<{ stage: string; sql: string }> = [];
  async function query(stage: string, sql: string): Promise<DatabaseQueryOutput> {
    signal?.throwIfAborted();
    queries.push({ stage, sql });
    const result = await execute({ action: 'query', connection: request.connection, sql }, signal ? { signal } : undefined);
    if (result.action !== 'query') throw new Error('Unexpected database query response.');
    if (connection && (result.connection !== connection || result.database !== database)) {
      throw new Error('Database identity changed during investigation.');
    }
    database = result.database;
    connection = result.connection;
    truncated ||= result.truncated;
    return result;
  }

  const catalog = await query('metadata schema', `SELECT t.name AS TableName, c.name AS ColumnName FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id WHERE s.name=N'dbo' AND UPPER(t.name) IN (${metadata.map(m => literal(m.table.toUpperCase())).join(',')}) AND UPPER(c.name) IN (${distinct(metadata.flatMap(m => [...m.keys, ...m.fields, ...m.links]).map(v => v.toUpperCase())).map(literal).join(',')}) ORDER BY t.name,c.column_id`);
  const available = new Map<string, Map<string, string>>();
  const tableNames = new Map<string, string>();
  for (const row of catalog.rows) {
    const table = text(row.TableName).toLowerCase();
    const column = text(row.ColumnName);
    tableNames.set(table, text(row.TableName));
    if (!available.has(table)) available.set(table, new Map());
    available.get(table)!.set(column.toLowerCase(), column);
  }
  if (catalog.truncated) limitations.push('Metadata catalog was truncated; coverage is incomplete.');
  const matches: Array<{ table: string; rows: Row[]; truncated: boolean }> = [];
  const inspected: string[] = [];
  const unavailable: string[] = [];
  const seeds = [term];
  const lookupFields: Array<{ table: string; column: string; role: string }> = [];
  for (const spec of metadata) {
    const columns = available.get(spec.table.toLowerCase());
    if (!columns) { unavailable.push(spec.table); continue; }
    const names = (values: readonly string[]) => distinct(values.map(v => columns.get(v.toLowerCase()) ?? ''));
    const keys = names(spec.keys);
    const fields = names([...spec.keys, ...spec.fields]);
    if (!keys.length) { unavailable.push(spec.table); continue; }
    inspected.push(spec.table);
    const predicate = keys.map(k => `${ident(k)} = ${literal(term)}`).join(' OR ');
    const sql = `SELECT TOP (${MAX_METADATA_ROWS + 1}) ${fields.map(k => ident(k)).join(', ')} FROM dbo.${ident(tableNames.get(spec.table.toLowerCase())!)} WHERE ${predicate} ORDER BY ${keys.map(ident).join(', ')}`;
    const result = await query(spec.table, sql);
    const rows = result.rows.slice(0, MAX_METADATA_ROWS);
    const clipped = result.truncated || result.rows.length > MAX_METADATA_ROWS;
    truncated ||= clipped;
    if (!rows.length) continue;
    matches.push({ table: spec.table, rows, truncated: clipped });
    for (const row of rows) {
      const get = (name: string) => text(row[columns.get(name.toLowerCase()) ?? '']);
      for (const link of spec.links) {
        const value = get(link);
        if (sqlName(value)) seeds.push(value);
      }
      if (spec.table === 'L00LOOKUP') {
        const table = get('Table_Lookup');
        for (const [key, role] of [['ColumnID_Lookup', 'key'], ['ColumnName_Lookup', 'display']]) {
          const column = get(key!);
          if (sqlName(table) && sqlName(column) && !column.includes('.')) lookupFields.push({ table, column, role: role! });
        }
      }
    }
  }

  const names = distinct(seeds.filter(sqlName));
  if (names.length > MAX_OBJECTS) {
    truncated = true;
    limitations.push('SQL object seeds exceeded the investigation budget.');
  }
  const selected = names.slice(0, MAX_OBJECTS).map(literal).join(',');
  const objectsResult = selected ? await query('SQL objects', `SELECT TOP (${MAX_OBJECTS + 1}) o.object_id AS ObjectId, s.name AS [Schema], o.name AS Name, o.type_desc AS Type, o.modify_date AS ModifiedAt FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 AND (o.name IN (${selected}) OR s.name+N'.'+o.name IN (${selected})) ORDER BY s.name,o.name`) : null;
  const objects = objectsResult?.rows.slice(0, MAX_OBJECTS) ?? [];
  truncated ||= (objectsResult?.rows.length ?? 0) > MAX_OBJECTS;
  const ids = objects.map(o => o.ObjectId).filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
  const dependenciesResult = ids.length ? await query('SQL dependencies', `SELECT DISTINCT TOP (${MAX_DEPENDENCIES + 1}) OBJECT_SCHEMA_NAME(d.referencing_id) AS FromSchema, OBJECT_NAME(d.referencing_id) AS FromName, d.referenced_server_name AS ToServer, d.referenced_database_name AS ToDatabase, COALESCE(OBJECT_SCHEMA_NAME(d.referenced_id),d.referenced_schema_name) AS ToSchema, d.referenced_entity_name AS ToName, d.referenced_id AS ToObjectId, d.is_ambiguous AS Ambiguous FROM sys.sql_expression_dependencies d WHERE d.referencing_id IN (${ids.join(',')}) OR d.referenced_id IN (${ids.join(',')}) ORDER BY FromSchema,FromName,ToDatabase,ToSchema,ToName`) : null;
  const dependencies = dependenciesResult?.rows.slice(0, MAX_DEPENDENCIES) ?? [];
  truncated ||= (dependenciesResult?.rows.length ?? 0) > MAX_DEPENDENCIES;

  const lookupChecks = [];
  for (const field of lookupFields) {
    const candidates = objects.filter(o => text(o.Name).toLowerCase() === field.table.toLowerCase() || (text(o.Schema)+'.'+text(o.Name)).toLowerCase() === field.table.toLowerCase());
    const id = candidates.length === 1 ? candidates[0]?.ObjectId : null;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      lookupChecks.push({ ...field, status: 'unresolved' });
      continue;
    }
    const result = await query('lookup column', `SELECT c.name AS ColumnName, TYPE_NAME(c.user_type_id) AS Type FROM sys.columns c WHERE c.object_id=${id} AND c.name=${literal(field.column)}`);
    lookupChecks.push({ ...field, objectId: id, status: result.rows.length ? 'present' : 'not-visible-in-catalog', evidence: result.rows });
  }

  const procedures = objects.filter(o => text(o.Type).includes('PROCEDURE')).map(o => text(o.Name));
  const source = request.sourceRoot && request.graphDepth === undefined && procedures.length ? await traceApplicationObjectTerms(request.sourceRoot, { procedures }) : null;
  if (request.sourceRoot && request.graphDepth === undefined && !source) limitations.push('No verified procedure to trace in source.');
  if (source?.truncated || (source?.matches.length ?? 0) > 30) truncated = true;
  if (unavailable.length) limitations.push('Some LinkQ metadata tables or key columns are absent or not visible.');
  const graph = request.graphDepth === undefined ? undefined : await expandBusinessGraph({
    term, depth: request.graphDepth, query, specs: metadata, catalog: available, tableNames,
    matches, objects, sourceRoot: request.sourceRoot
  });
  if (graph?.truncated) truncated = true;
  return {
    connection, database, search: term, capturedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    metadata: matches, inspected, unavailable, objects, dependencies, lookupChecks,
    source: source ? { ...source, matches: source.matches.slice(0, 30), truncated: source.truncated || source.matches.length > 30 } : null,
    evidenceQueries: queries, truncated, limitations, ...(graph ? { graph } : {})
  };
}
