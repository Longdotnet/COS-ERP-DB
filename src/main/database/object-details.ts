import type {
  DatabaseObjectColumnDetail,
  DatabaseObjectDependencyDetail,
  DatabaseObjectDetailsResult,
  DatabaseObjectDetailSection,
  DatabaseObjectForeignKeyDetail,
  DatabaseObjectIndexDetail,
  DatabaseObjectType
} from '../../shared/database.js';
import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';

const MAX_DETAIL_ROWS = 1025;
const MAX_DEPENDENCIES = 256;
const MAX_DEFINITION_BYTES = 256_000;
const DETAIL_BYTES = 1_000_000;

type DetailQuery = (
  connection: SqlServerConnection,
  sql: string,
  options: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

interface ObjectHeader {
  schema: string;
  name: string;
  type: DatabaseObjectType;
  sqlType: string;
}

const HEADER_SQL = `
SELECT s.name AS schema_name, o.name AS object_name, o.type AS sql_type
FROM sys.objects AS o
INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.object_id = @object_id AND o.is_ms_shipped = 0;`;

const COLUMNS_SQL = `
SELECT
  c.column_id,
  c.name AS column_name,
  ts.name AS type_schema,
  ty.name AS type_name,
  c.max_length,
  c.precision,
  c.scale,
  c.is_nullable,
  CASE WHEN ic.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_identity,
  CASE WHEN cc.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_computed,
  dc.definition AS default_definition,
  cc.definition AS computed_definition,
  cc.is_persisted
FROM sys.columns AS c
INNER JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
INNER JOIN sys.schemas AS ts ON ts.schema_id = ty.schema_id
LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints AS dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE c.object_id = @object_id
ORDER BY c.column_id;`;

const INDEXES_SQL = `
SELECT
  i.index_id,
  i.name AS index_name,
  i.type_desc,
  i.is_unique,
  i.is_primary_key,
  i.is_unique_constraint,
  i.is_disabled,
  ic.key_ordinal,
  ic.index_column_id,
  ic.is_descending_key,
  ic.is_included_column,
  c.name AS column_name
FROM sys.indexes AS i
INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = @object_id AND i.index_id > 0 AND i.is_hypothetical = 0
ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id;`;

const FOREIGN_KEYS_SQL = `
SELECT
  fk.object_id AS fk_id,
  fk.name AS fk_name,
  fkc.constraint_column_id,
  pc.name AS parent_column,
  rs.name AS referenced_schema,
  rt.name AS referenced_table,
  rc.name AS referenced_column,
  fk.delete_referential_action_desc,
  fk.update_referential_action_desc
FROM sys.foreign_keys AS fk
INNER JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
INNER JOIN sys.columns AS pc ON pc.object_id = fk.parent_object_id AND pc.column_id = fkc.parent_column_id
INNER JOIN sys.tables AS rt ON rt.object_id = fk.referenced_object_id
INNER JOIN sys.schemas AS rs ON rs.schema_id = rt.schema_id
INNER JOIN sys.columns AS rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id = @object_id
ORDER BY fk.object_id, fkc.constraint_column_id;`;

const DEFINITION_SQL = `SELECT OBJECT_DEFINITION(@object_id) AS definition;`;
const SYNONYM_SQL = `SELECT base_object_name FROM sys.synonyms WHERE object_id = @object_id;`;

const OUTBOUND_DEPENDENCIES_SQL = `
SELECT TOP (@take)
  d.referenced_server_name AS server_name,
  d.referenced_database_name AS database_name,
  COALESCE(rs.name, d.referenced_schema_name) AS schema_name,
  COALESCE(ro.name, d.referenced_entity_name) AS object_name,
  ro.type AS sql_type
FROM sys.sql_expression_dependencies AS d
LEFT JOIN sys.objects AS ro ON ro.object_id = d.referenced_id
LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id
WHERE d.referencing_id = @object_id
ORDER BY COALESCE(rs.name, d.referenced_schema_name), COALESCE(ro.name, d.referenced_entity_name);`;

const INBOUND_DEPENDENCIES_SQL = `
SELECT TOP (@take)
  CAST(NULL AS sysname) AS server_name,
  CAST(NULL AS sysname) AS database_name,
  COALESCE(d.referencing_schema_name, s.name) AS schema_name,
  COALESCE(d.referencing_entity_name, o.name) AS object_name,
  o.type AS sql_type
FROM sys.dm_sql_referencing_entities(@entity_name, N'OBJECT') AS d
LEFT JOIN sys.objects AS o ON o.object_id = d.referencing_id
LEFT JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.object_id IS NULL OR o.is_ms_shipped = 0
ORDER BY COALESCE(d.referencing_schema_name, s.name), COALESCE(d.referencing_entity_name, o.name);`;

function objectType(sqlType: string): DatabaseObjectType | null {
  const type = sqlType.trim();
  if (type === 'U') return 'table';
  if (type === 'V') return 'view';
  if (type === 'P' || type === 'PC') return 'procedure';
  if (['FN', 'IF', 'TF', 'FS', 'FT'].includes(type)) return 'function';
  if (type === 'SN') return 'synonym';
  return null;
}

function rowString(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] as string : null;
}

function rowInteger(row: Record<string, unknown>, key: string): number | null {
  return typeof row[key] === 'number' && Number.isInteger(row[key]) ? row[key] as number : null;
}

function quoteIdentifier(value: string): string {
  return `[${value.replace(/]/g, ']]')}]`;
}

async function header(connection: SqlServerConnection, objectId: number, signal: AbortSignal | undefined, query: DetailQuery): Promise<{ header: ObjectHeader; elapsedMs: number }> {
  if (!Number.isInteger(objectId) || objectId <= 0) throw new Error('Object objectId must be a positive integer.');
  const result = await query(connection, HEADER_SQL, {
    maxRows: 2,
    maxBytes: 16_384,
    ...(signal ? { signal } : {}),
    parameters: { object_id: objectId }
  });
  const row = result.rows[0];
  if (!row) throw new Error('OBJECT_NOT_FOUND: the selected SQL Server object does not exist.');
  const schema = rowString(row, 'schema_name');
  const name = rowString(row, 'object_name');
  const sqlType = rowString(row, 'sql_type');
  const type = sqlType ? objectType(sqlType) : null;
  if (!schema || !name || !sqlType || !type) throw new Error('SQL Server returned malformed object metadata.');
  return { header: { schema, name, sqlType: sqlType.trim(), type }, elapsedMs: result.elapsedMs };
}

function typeDeclaration(row: Record<string, unknown>): string {
  const schema = rowString(row, 'type_schema') ?? 'sys';
  const type = rowString(row, 'type_name') ?? 'unknown';
  const maxLength = rowInteger(row, 'max_length');
  const precision = rowInteger(row, 'precision');
  const scale = rowInteger(row, 'scale');
  const base = schema === 'sys' || schema === 'dbo' ? type : `${quoteIdentifier(schema)}.${quoteIdentifier(type)}`;
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type) && maxLength !== null) return `${base}(${maxLength === -1 ? 'max' : maxLength})`;
  if (['nvarchar', 'nchar'].includes(type) && maxLength !== null) return `${base}(${maxLength === -1 ? 'max' : Math.floor(maxLength / 2)})`;
  if (['decimal', 'numeric'].includes(type) && precision !== null && scale !== null) return `${base}(${precision},${scale})`;
  if (['datetime2', 'datetimeoffset', 'time'].includes(type) && scale !== null) return `${base}(${scale})`;
  return base;
}

async function columnRows(connection: SqlServerConnection, objectId: number, signal: AbortSignal | undefined, query: DetailQuery): Promise<SqlServerQueryResult> {
  return query(connection, COLUMNS_SQL, {
    maxRows: MAX_DETAIL_ROWS,
    maxBytes: DETAIL_BYTES,
    ...(signal ? { signal } : {}),
    parameters: { object_id: objectId }
  });
}

function mapColumns(result: SqlServerQueryResult): DatabaseObjectColumnDetail[] {
  return result.rows.map(row => {
    const ordinal = rowInteger(row, 'column_id');
    const name = rowString(row, 'column_name');
    if (ordinal === null || !name) throw new Error('SQL Server returned malformed column metadata.');
    return {
      ordinal,
      name,
      type: typeDeclaration(row),
      nullable: row.is_nullable === true,
      identity: row.is_identity === true,
      computed: row.is_computed === true,
      defaultDefinition: rowString(row, 'default_definition'),
      computedDefinition: rowString(row, 'computed_definition')
    };
  });
}

async function indexesAndKeys(connection: SqlServerConnection, objectId: number, signal: AbortSignal | undefined, query: DetailQuery): Promise<{ indexes: DatabaseObjectIndexDetail[]; foreignKeys: DatabaseObjectForeignKeyDetail[]; truncated: boolean; elapsedMs: number }> {
  const [indexesResult, fkResult] = await Promise.all([
    query(connection, INDEXES_SQL, {
      maxRows: MAX_DETAIL_ROWS,
      maxBytes: DETAIL_BYTES,
      ...(signal ? { signal } : {}),
      parameters: { object_id: objectId }
    }),
    query(connection, FOREIGN_KEYS_SQL, {
      maxRows: MAX_DETAIL_ROWS,
      maxBytes: DETAIL_BYTES,
      ...(signal ? { signal } : {}),
      parameters: { object_id: objectId }
    })
  ]);
  const indexes = new Map<number, DatabaseObjectIndexDetail>();
  for (const row of indexesResult.rows) {
    const id = rowInteger(row, 'index_id');
    const name = rowString(row, 'index_name');
    const column = rowString(row, 'column_name');
    const ordinal = rowInteger(row, 'index_column_id');
    if (id === null || !name || !column || ordinal === null) throw new Error('SQL Server returned malformed index metadata.');
    let index = indexes.get(id);
    if (!index) {
      index = {
        name,
        type: rowString(row, 'type_desc') ?? 'UNKNOWN',
        unique: row.is_unique === true,
        primaryKey: row.is_primary_key === true,
        uniqueConstraint: row.is_unique_constraint === true,
        disabled: row.is_disabled === true,
        columns: []
      };
      indexes.set(id, index);
    }
    index.columns.push({
      name: column,
      descending: row.is_descending_key === true,
      included: row.is_included_column === true,
      ordinal
    });
  }
  const foreignKeys = new Map<number, DatabaseObjectForeignKeyDetail>();
  for (const row of fkResult.rows) {
    const id = rowInteger(row, 'fk_id');
    const name = rowString(row, 'fk_name');
    const column = rowString(row, 'parent_column');
    const referencedSchema = rowString(row, 'referenced_schema');
    const referencedTable = rowString(row, 'referenced_table');
    const referencedColumn = rowString(row, 'referenced_column');
    if (id === null || !name || !column || !referencedSchema || !referencedTable || !referencedColumn) throw new Error('SQL Server returned malformed foreign-key metadata.');
    let foreignKey = foreignKeys.get(id);
    if (!foreignKey) {
      foreignKey = {
        name,
        columns: [],
        referencedSchema,
        referencedTable,
        referencedColumns: [],
        deleteAction: rowString(row, 'delete_referential_action_desc') ?? 'NO_ACTION',
        updateAction: rowString(row, 'update_referential_action_desc') ?? 'NO_ACTION'
      };
      foreignKeys.set(id, foreignKey);
    }
    foreignKey.columns.push(column);
    foreignKey.referencedColumns.push(referencedColumn);
  }
  return {
    indexes: [...indexes.values()],
    foreignKeys: [...foreignKeys.values()],
    truncated: indexesResult.truncated || fkResult.truncated,
    elapsedMs: Math.max(indexesResult.elapsedMs, fkResult.elapsedMs)
  };
}

function tableDdl(header: ObjectHeader, rows: Record<string, unknown>[], indexes: DatabaseObjectIndexDetail[]): string {
  const columns = rows.map(row => {
    const name = rowString(row, 'column_name');
    if (!name) throw new Error('SQL Server returned malformed column metadata.');
    const computed = row.is_computed === true;
    if (computed) {
      const definition = rowString(row, 'computed_definition') ?? '/* unavailable */';
      return `  ${quoteIdentifier(name)} AS ${definition}${row.is_persisted === true ? ' PERSISTED' : ''}`;
    }
    const parts = [`  ${quoteIdentifier(name)} ${typeDeclaration(row)}`];
    if (row.is_identity === true) parts.push('IDENTITY');
    parts.push(row.is_nullable === true ? 'NULL' : 'NOT NULL');
    const defaultDefinition = rowString(row, 'default_definition');
    if (defaultDefinition) parts.push(`DEFAULT ${defaultDefinition}`);
    return parts.join(' ');
  });
  const primary = indexes.find(index => index.primaryKey);
  if (primary) {
    const keys = primary.columns.filter(column => !column.included).map(column => `${quoteIdentifier(column.name)} ${column.descending ? 'DESC' : 'ASC'}`).join(', ');
    columns.push(`  CONSTRAINT ${quoteIdentifier(primary.name)} PRIMARY KEY ${primary.type.includes('CLUSTERED') ? 'CLUSTERED' : 'NONCLUSTERED'} (${keys})`);
  }
  return `CREATE TABLE ${quoteIdentifier(header.schema)}.${quoteIdentifier(header.name)} (\n${columns.join(',\n')}\n);`;
}

async function ddl(connection: SqlServerConnection, objectId: number, object: ObjectHeader, signal: AbortSignal | undefined, query: DetailQuery): Promise<DatabaseObjectDetailsResult['ddl'] & { elapsedMs: number }> {
  if (object.type === 'table') {
    const [columnsResult, indexResult] = await Promise.all([
      columnRows(connection, objectId, signal, query),
      indexesAndKeys(connection, objectId, signal, query)
    ]);
    return {
      text: tableDdl(object, columnsResult.rows, indexResult.indexes),
      kind: 'generated-table',
      complete: false,
      note: 'Generated structural script from current metadata. It includes columns, defaults, computed columns and the primary key, but intentionally omits secondary indexes, foreign keys, triggers, temporal/partition/filegroup options and other advanced table properties.',
      truncated: columnsResult.truncated || indexResult.truncated,
      elapsedMs: Math.max(columnsResult.elapsedMs, indexResult.elapsedMs)
    };
  }
  if (object.type === 'synonym') {
    const result = await query(connection, SYNONYM_SQL, {
      maxRows: 2,
      maxBytes: 16_384,
      ...(signal ? { signal } : {}),
      parameters: { object_id: objectId }
    });
    const base = result.rows[0] ? rowString(result.rows[0], 'base_object_name') : null;
    return {
      text: base ? `CREATE SYNONYM ${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)} FOR ${base};` : '',
      kind: base ? 'synonym' : 'unavailable',
      complete: Boolean(base),
      elapsedMs: result.elapsedMs
    };
  }
  const result = await query(connection, DEFINITION_SQL, {
    maxRows: 2,
    maxBytes: MAX_DEFINITION_BYTES,
    ...(signal ? { signal } : {}),
    parameters: { object_id: objectId }
  });
  const definition = result.rows[0] ? rowString(result.rows[0], 'definition') : null;
  const text = definition ?? '';
  const bytes = Buffer.byteLength(text, 'utf8');
  return {
    text: bytes > MAX_DEFINITION_BYTES ? Buffer.from(text, 'utf8').subarray(0, MAX_DEFINITION_BYTES).toString('utf8') : text,
    kind: definition ? 'source' : 'unavailable',
    complete: Boolean(definition) && bytes <= MAX_DEFINITION_BYTES && !result.truncated,
    ...(bytes > MAX_DEFINITION_BYTES || result.truncated ? { truncated: true } : {}),
    elapsedMs: result.elapsedMs
  };
}

function dependencyType(sqlType: unknown): string | null {
  return typeof sqlType === 'string' ? objectType(sqlType)?.toString() ?? sqlType.trim() : null;
}

function mapDependencies(rows: readonly Record<string, unknown>[]): DatabaseObjectDependencyDetail[] {
  return rows.map(row => ({
    server: rowString(row, 'server_name'),
    database: rowString(row, 'database_name'),
    schema: rowString(row, 'schema_name'),
    name: rowString(row, 'object_name') ?? '(unresolved)',
    type: dependencyType(row.sql_type)
  }));
}

export async function readSqlServerObjectDetails(
  connection: SqlServerConnection,
  objectId: number,
  section: DatabaseObjectDetailSection,
  options: { signal?: AbortSignal } = {},
  query: DetailQuery = (resolved, sql, queryOptions) => querySqlServer(resolved, sql, undefined, queryOptions)
): Promise<DatabaseObjectDetailsResult> {
  const resolved = await header(connection, objectId, options.signal, query);
  const base = { schema: resolved.header.schema, name: resolved.header.name, type: resolved.header.type, section } as const;
  if (section === 'columns') {
    const result = await columnRows(connection, objectId, options.signal, query);
    return { ...base, columns: mapColumns(result), truncated: result.truncated, elapsedMs: resolved.elapsedMs + result.elapsedMs };
  }
  if (section === 'keys_indexes') {
    if (resolved.header.type !== 'table') return { ...base, indexes: [], foreignKeys: [], elapsedMs: resolved.elapsedMs };
    const result = await indexesAndKeys(connection, objectId, options.signal, query);
    return { ...base, indexes: result.indexes, foreignKeys: result.foreignKeys, truncated: result.truncated, elapsedMs: resolved.elapsedMs + result.elapsedMs };
  }
  if (section === 'ddl') {
    const result = await ddl(connection, objectId, resolved.header, options.signal, query);
    const { elapsedMs, ...definition } = result;
    return { ...base, ddl: definition, elapsedMs: resolved.elapsedMs + elapsedMs };
  }
  const [outbound, inbound] = await Promise.all([
    query(connection, OUTBOUND_DEPENDENCIES_SQL, {
      maxRows: MAX_DEPENDENCIES + 1,
      maxBytes: DETAIL_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
      parameters: { object_id: objectId, take: MAX_DEPENDENCIES + 1 }
    }),
    query(connection, INBOUND_DEPENDENCIES_SQL, {
      maxRows: MAX_DEPENDENCIES + 1,
      maxBytes: DETAIL_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
      parameters: { entity_name: `${quoteIdentifier(resolved.header.schema)}.${quoteIdentifier(resolved.header.name)}`, take: MAX_DEPENDENCIES + 1 }
    })
  ]);
  const outboundDependencies = mapDependencies(outbound.rows.slice(0, MAX_DEPENDENCIES));
  const inboundDependencies = mapDependencies(inbound.rows.slice(0, MAX_DEPENDENCIES));
  return {
    ...base,
    outboundDependencies,
    inboundDependencies,
    truncated: outbound.rows.length > MAX_DEPENDENCIES || inbound.rows.length > MAX_DEPENDENCIES || outbound.truncated || inbound.truncated,
    elapsedMs: resolved.elapsedMs + Math.max(outbound.elapsedMs, inbound.elapsedMs)
  };
}
