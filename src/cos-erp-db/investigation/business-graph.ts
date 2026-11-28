import { createHash } from 'node:crypto';
import type { DatabaseQueryOutput } from '../../main/database/service.js';
import { traceApplicationObjectTerms } from './source-trace.js';

type Row = Record<string, unknown>;
type Query = (stage: string, sql: string) => Promise<DatabaseQueryOutput>;
type Spec = { table: string; keys: readonly string[]; fields: readonly string[]; links: readonly string[] };
type Node = { id: string; kind: 'request' | 'metadata' | 'sql' | 'unresolved' | 'source' | 'permission'; label: string; depth: number; evidence?: Row };
type Edge = { from: string; to: string; relation: string; evidence: string };
type MetadataNode = { id: string; table: string; row: Row };
type Rule = [fromTable: string, fromColumn: string, toTable: string, toColumn: string];

const MAX_NODES = 120;
const MAX_EDGES = 240;
const MAX_SQL_IDS = 40;
const MAX_METADATA_QUERIES = 24;
const MAX_ROWS = 12;
const MAX_DEPENDENCIES = 80;
const literal = (value: string) => "N'" + value.replace(/'/g, "''") + "'";
const ident = (value: string) => '[' + value.replace(/]/g, ']]') + ']';
const field = (row: Row, name: string) => {
  const value = Object.entries(row).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
};
const validName = (value: string) => /^[\p{L}\p{N}_$#]+(?:\.[\p{L}\p{N}_$#]+)?$/u.test(value);
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const rowId = (table: string, row: Row) => 'metadata:' + table + ':' + createHash('sha256').update(JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).digest('hex').slice(0, 24);

// Follow only named LinkQ contracts. A shared column name is a candidate lookup binding,
// never proof of which lookup runs in the UI.
const rules: Rule[] = [
  ['L00REPORT','Report_Id','L00FormConfig','Form_ID'],
  ['L00REPORT','Report_Id','L00FormLayout','Form_ID'],
  ['L00REPORT','Report_Parent','L00REPORT','Report_Id'],
  ['L00REPORT','Report_ID_Filter','L00REPORT','Report_Id'],
  ['L00MENU','Table_Name','L00DMTABLE','Table_Name'],
  ['L00DMTABLE','Table_Name','L00MENU','Table_Name'],
  ['L00DMTABLE','Table_Cha','L00DMTABLE','Table_Name'],
  ['L00DMTABLE','Form_Id','L00FormConfig','Form_ID'],
  ['L00DMTABLE','Form_Id','L00FormLayout','Form_ID'],
  ['L00FormConfig','Form_ID','L00DMTABLE','Form_Id'],
  ['L00FormConfig','Form_ID','L00FormLayout','Form_ID'],
  ['L00DMTABLE','Zone','L00COLUMNS','Zone'],
  ['L00DMCT','Zone_ViewPh','L00COLUMNS','Zone'],
  ['L00DMCT','Zone_ViewCt','L00COLUMNS','Zone'],
  ['L00LOOKUP','Zone','L00COLUMNS','Zone'],
  ['L00FormLayout','Column_ID','L00LOOKUP','ColumnID'],
  ['L00FormLayout','Column_Lookup','L00LOOKUP','ColumnID'],
  ['L00COLUMNS','Column_ID','L00LOOKUP','ColumnID'],
  ['L00OBJECT','OBJECT_ID_PARENT','L00OBJECT','Object_ID']
];
for (const table of ['L00REPORT','L00MENU','L00DMTABLE','L00DMCT']) {
  rules.push([table,'Object_ID','L00OBJECT','Object_ID']);
}

export async function expandBusinessGraph(input: {
  term: string; depth: number; query: Query; specs: readonly Spec[];
  catalog: Map<string, Map<string, string>>; tableNames: Map<string, string>;
  matches: Array<{ table: string; rows: Row[]; truncated: boolean }>;
  objects: Row[]; sourceRoot?: string;
}) {
  const { term, depth, query, specs, catalog, tableNames } = input;
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const limitations = new Set<string>([
    'Live graph contains observed metadata joins and SQL catalog references, not proven runtime execution.',
    'Metadata and SQL expansion have independent depth budgets. Lookup field-name links are candidates; effective user rights require separate verification.',
    'Dynamic SQL, encrypted modules, cross-database and unresolved references are not recursively expanded.'
  ]);
  let truncated = false;
  const addNode = (node: Node) => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= MAX_NODES) { truncated = true; return false; }
    nodes.set(node.id, node);
    return true;
  };
  const addEdge = (from: string, to: string, relation: string, evidence: string) => {
    if (!nodes.has(from) || !nodes.has(to) || from === to) return;
    const key = JSON.stringify([from, to, relation, evidence]);
    if (edges.has(key)) return;
    if (edges.size >= MAX_EDGES) { truncated = true; return; }
    edges.set(key, { from, to, relation, evidence });
  };
  addNode({ id: 'request', kind: 'request', label: term, depth: 0 });
  const rowsById = new Map<string, MetadataNode>();
  const addRow = (table: string, row: Row, level: number) => {
    const id = rowId(table, row);
    const spec = specs.find(s => s.table === table);
    const label = spec?.keys.map(key => field(row, key)).find(Boolean) ?? table;
    if (!addNode({ id, kind: 'metadata', label: table + ': ' + label, depth: level, evidence: row })) return null;
    if (!rowsById.has(id)) rowsById.set(id, { id, table, row });
    return id;
  };
  for (const match of input.matches) {
    truncated ||= match.truncated;
    for (const row of match.rows) {
      const id = addRow(match.table, row, 1);
      if (id) addEdge('request', id, 'matches-identifier', match.table + ' exact search');
    }
  }

  const visited = new Set<string>();
  let frontier = [...rowsById.values()];
  let metadataQueries = 0;
  for (let level = 1; level < depth && frontier.length; level++) {
    const groups = new Map<string, { table: string; column: string; parents: Array<{ node: MetadataNode; field: string; value: string }> }>();
    for (const node of frontier) {
      for (const [from, fromColumn, to, toColumn] of rules) {
        if (from !== node.table) continue;
        const value = field(node.row, fromColumn);
        if (!value || value.length > 128) continue;
        const visit = JSON.stringify([node.id, fromColumn, to, toColumn]);
        if (visited.has(visit)) continue;
        visited.add(visit);
        const key = to + ':' + toColumn;
        if (!groups.has(key)) groups.set(key, { table: to, column: toColumn, parents: [] });
        groups.get(key)!.parents.push({ node, field: fromColumn, value });
      }
    }
    const next: MetadataNode[] = [];
    for (const group of groups.values()) {
      const columns = catalog.get(group.table.toLowerCase());
      const matchColumn = columns?.get(group.column.toLowerCase());
      const spec = specs.find(s => s.table === group.table);
      if (!columns || !matchColumn || !spec) continue;
      if (metadataQueries >= MAX_METADATA_QUERIES || nodes.size >= MAX_NODES) { truncated = true; break; }
      const selected = [...new Set([...spec.keys, ...spec.fields].map(k => columns.get(k.toLowerCase())).filter((k): k is string => !!k))];
      const values = [...new Set(group.parents.map(p => p.value))];
      const sql = `SELECT TOP (${MAX_ROWS + 1}) ${selected.map(ident).join(',')} FROM dbo.${ident(tableNames.get(group.table.toLowerCase())!)} WHERE ${ident(matchColumn)} IN (${values.map(literal).join(',')}) ORDER BY ${ident(matchColumn)},${selected.filter(c => c !== matchColumn).map(ident).join(',') || ident(matchColumn)}`;
      metadataQueries++;
      const result = await query('graph metadata ' + group.table + '.' + group.column, sql);
      truncated ||= result.truncated || result.rows.length > MAX_ROWS;
      for (const row of result.rows.slice(0, MAX_ROWS)) {
        const value = field(row, group.column);
        // SQL collation can be case/accent insensitive; only link exact case-insensitive values here.
        const parents = group.parents.filter(p => p.value.toLowerCase() === value.toLowerCase());
        if (!parents.length) { limitations.add('A metadata match could not be linked by exact case-insensitive equality.'); continue; }
        const id = rowId(group.table, row);
        const fresh = !rowsById.has(id);
        if (!addRow(group.table, row, level + 1)) continue;
        if (fresh) next.push(rowsById.get(id)!);
        for (const parent of parents) {
          const candidate = group.table === 'L00LOOKUP' && ['L00COLUMNS','L00FormLayout'].includes(parent.node.table);
          addEdge(parent.node.id, id, candidate ? 'lookup-candidate' : 'metadata-reference',
            parent.node.table + '.' + parent.field + ' = ' + group.table + '.' + group.column);
        }
      }
    }
    frontier = next;
  }
  if (frontier.length && depth > 1) limitations.add('Metadata traversal stopped at the requested depth.');

  const sqlSeeds = new Map<string, Array<{ id: string; evidence: string }>>();
  const seed = (name: string, id: string, evidence: string) => {
    if (!validName(name)) return;
    if (!sqlSeeds.has(name)) sqlSeeds.set(name, []);
    sqlSeeds.get(name)!.push({ id, evidence });
  };
  seed(term, 'request', 'exact SQL object name');
  for (const node of rowsById.values()) {
    const spec = specs.find(s => s.table === node.table);
    for (const link of spec?.links ?? []) seed(field(node.row, link), node.id, node.table + '.' + link);
  }
  const seedNames = [...sqlSeeds.keys()];
  if (seedNames.length > MAX_SQL_IDS) truncated = true;
  const names = seedNames.slice(0, MAX_SQL_IDS).map(literal).join(',');
  const resolved = names ? await query('graph SQL seeds', `SELECT TOP (${MAX_SQL_IDS + 1}) o.object_id AS ObjectId,s.name AS [Schema],o.name AS Name,o.type_desc AS Type FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 AND (o.name IN (${names}) OR s.name+N'.'+o.name IN (${names})) ORDER BY s.name,o.name`) : null;
  truncated ||= !!resolved && (resolved.truncated || resolved.rows.length > MAX_SQL_IDS);
  const sqlObjects = new Map<number, Row>();
  const ensureSql = (row: Row, level: number) => {
    if (!positiveId(row.ObjectId)) return null;
    const id = 'sql:' + row.ObjectId;
    if (!addNode({ id, kind: 'sql', label: [field(row,'Schema'),field(row,'Name')].filter(Boolean).join('.'), depth: level, evidence: row })) return null;
    if (!sqlObjects.has(row.ObjectId)) sqlObjects.set(row.ObjectId, row);
    return id;
  };
  for (const row of [...input.objects, ...(resolved?.rows.slice(0, MAX_SQL_IDS) ?? [])]) ensureSql(row, 1);
  for (const [name, parents] of sqlSeeds) {
    const matching = [...sqlObjects.values()].filter(row => [field(row,'Name'), field(row,'Schema') + '.' + field(row,'Name')].some(v => v.toLowerCase() === name.toLowerCase()));
    for (const row of matching) for (const parent of parents) addEdge(parent.id, 'sql:' + row.ObjectId, matching.length > 1 ? 'sql-candidate' : 'sql-reference', parent.evidence);
    if (parents.some(p => p.id !== 'request') && !matching.length) {
      const id = 'unresolved:' + name;
      if (addNode({ id, kind: 'unresolved', label: name, depth: 1 })) for (const parent of parents) addEdge(parent.id, id, 'unresolved-reference', parent.evidence);
    }
  }

  const rootIds = [...sqlObjects.keys()];
  const visitedSql = new Set<number>();
  let sqlFrontier = rootIds;
  for (let level = 1; level <= depth && sqlFrontier.length; level++) {
    if (sqlFrontier.length > MAX_SQL_IDS) truncated = true;
    const ids = sqlFrontier.slice(0, MAX_SQL_IDS);
    ids.forEach(id => visitedSql.add(id));
    const list = ids.join(',');
    // Explore dependencies outward at every hop; reverse consumers only for roots.
    // Walking reverse edges at every hop through shared ERP tables creates unrelated fan-out.
    const predicate = `d.referencing_id IN (${list})` + (level === 1 ? ` OR d.referenced_id IN (${list})` : '');
    const result = await query('graph SQL dependencies ' + level, `SELECT DISTINCT TOP (${MAX_DEPENDENCIES + 1}) d.referencing_id AS FromObjectId,OBJECT_SCHEMA_NAME(d.referencing_id) AS FromSchema,OBJECT_NAME(d.referencing_id) AS FromName,fo.type_desc AS FromType,d.referenced_id AS ToObjectId,COALESCE(OBJECT_SCHEMA_NAME(d.referenced_id),d.referenced_schema_name) AS ToSchema,d.referenced_entity_name AS ToName,ro.type_desc AS ToType,d.referenced_server_name AS ToServer,d.referenced_database_name AS ToDatabase,d.is_ambiguous AS Ambiguous FROM sys.sql_expression_dependencies d JOIN sys.objects fo ON fo.object_id=d.referencing_id LEFT JOIN sys.objects ro ON ro.object_id=d.referenced_id WHERE ${predicate} ORDER BY FromObjectId,ToObjectId,ToName,ToDatabase,ToServer`);
    truncated ||= result.truncated || result.rows.length > MAX_DEPENDENCIES;
    const next = new Set<number>();
    for (const row of result.rows.slice(0, MAX_DEPENDENCIES)) {
      const from = ensureSql({ ObjectId: row.FromObjectId, Schema: row.FromSchema, Name: row.FromName, Type: row.FromType }, level + 1);
      const local = !row.ToServer && !row.ToDatabase && positiveId(row.ToObjectId);
      let to: string | null = null;
      if (local) {
        to = ensureSql({ ObjectId: row.ToObjectId, Schema: row.ToSchema, Name: row.ToName, Type: row.ToType }, level + 1);
        if (to && ids.includes(row.FromObjectId as number) && !visitedSql.has(row.ToObjectId as number)) next.add(row.ToObjectId as number);
      } else {
        const label = [row.ToServer,row.ToDatabase,row.ToSchema,row.ToName].filter(Boolean).join('.');
        const id = 'unresolved:' + label;
        if (addNode({ id, kind: 'unresolved', label, depth: level + 1 })) to = id;
      }
      if (from && to) addEdge(from, to, row.Ambiguous ? 'sql-dependency-candidate' : 'sql-dependency', 'sys.sql_expression_dependencies');
    }
    sqlFrontier = [...next];
  }
  if (sqlFrontier.length) limitations.add('SQL traversal stopped at the requested depth.');

  // Permission configuration is represented by aggregate counts only, never member identities.
  const permissionParents = [...rowsById.values()].filter(n => ['L00REPORT','L00DMTABLE','L00MENU','L00DMCT','L00OBJECT'].includes(n.table) && field(n.row,'Object_ID'));
  const permissionKeys = [...new Set(permissionParents.map(n => field(n.row,'Object_ID')))].slice(0, 20);
  if (permissionKeys.length) {
    const schema = await query('graph permission schema', "SELECT OBJECT_ID(N'dbo.L00PERMISSION',N'U') AS TableId,COL_LENGTH(N'dbo.L00PERMISSION',N'Object_ID') AS KeyBytes");
    if (schema.rows[0]?.TableId != null && schema.rows[0]?.KeyBytes != null) {
      const result = await query('graph permission summary', `SELECT Object_ID,COUNT_BIG(*) AS RuleCount FROM dbo.L00PERMISSION WHERE Object_ID IN (${permissionKeys.map(literal).join(',')}) GROUP BY Object_ID ORDER BY Object_ID`);
      for (const row of result.rows) {
        const name = field(row,'Object_ID');
        const id = 'permission:' + name;
        if (addNode({ id, kind: 'permission', label: 'L00PERMISSION: ' + name, depth: 2, evidence: row })) {
          for (const parent of permissionParents.filter(n => field(n.row,'Object_ID').toLowerCase() === name.toLowerCase())) addEdge(parent.id, id, 'permission-config', 'Object_ID equality; aggregate only');
        }
      }
    } else limitations.add('L00PERMISSION or Object_ID is absent or not visible.');
  }

  if (input.sourceRoot) {
    const procedures = [...sqlObjects.values()].filter(row => field(row,'Type').includes('PROCEDURE')).map(row => field(row,'Name'));
    if (procedures.length) {
      const source = await traceApplicationObjectTerms(input.sourceRoot, { procedures });
      truncated ||= source.truncated || source.matches.length > 30;
      for (const item of source.matches.slice(0, 30)) {
        const id = 'source:' + item.path + ':' + item.line;
        if (!addNode({ id, kind: 'source', label: item.path + ':' + item.line, depth: depth + 1, evidence: { preview: item.preview, matchedTerm: item.matchedTerm } })) continue;
        for (const [objectId, row] of sqlObjects) if (field(row,'Name').toLowerCase() === item.matchedTerm.toLowerCase()) addEdge(id, 'sql:' + objectId, 'source-text-reference', 'source token match; not runtime proof');
      }
    } else limitations.add('No procedure identified for source tracing.');
  }
  return { depth, nodes: [...nodes.values()], edges: [...edges.values()], metadataQueries, truncated, limitations: [...limitations] };
}
