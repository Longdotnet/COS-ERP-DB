import { createHash } from 'node:crypto';
import { querySqlServer, type SqlServerConnection, type SqlServerQueryResult } from '../../main/database/sqlserver.js';
import type { DatabaseDeploymentFingerprint } from './types.js';

const MAX_ROWS = 50_000;
const MAX_BYTES = 16 * 1024 * 1024;

const CONFIG_SQL = [
  'SELECT compatibility_level, collation_name, recovery_model_desc,',
  '       is_read_committed_snapshot_on, snapshot_isolation_state_desc',
  'FROM sys.databases',
  'WHERE name = DB_NAME();'
].join('\n');

const OBJECTS_SQL = [
  'SELECT s.name AS schema_name, o.name AS object_name, o.type AS object_type',
  'FROM sys.objects o',
  'JOIN sys.schemas s ON s.schema_id = o.schema_id',
  'WHERE o.is_ms_shipped = 0',
  'ORDER BY s.name, o.name, o.type;'
].join('\n');

const COLUMNS_SQL = [
  'SELECT s.name AS schema_name, t.name AS table_name, c.column_id, c.name AS column_name,',
  '       ty.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable,',
  '       c.is_identity, c.is_computed, c.collation_name',
  'FROM sys.tables t',
  'JOIN sys.schemas s ON s.schema_id = t.schema_id',
  'JOIN sys.columns c ON c.object_id = t.object_id',
  'JOIN sys.types ty ON ty.user_type_id = c.user_type_id',
  'WHERE t.is_ms_shipped = 0',
  'ORDER BY s.name, t.name, c.column_id;'
].join('\n');

const INDEXES_SQL = [
  'SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name, i.type_desc,',
  '       i.is_unique, i.is_primary_key, i.is_unique_constraint, i.filter_definition,',
  '       ic.key_ordinal, ic.is_included_column, ic.is_descending_key, c.name AS column_name',
  'FROM sys.tables t',
  'JOIN sys.schemas s ON s.schema_id = t.schema_id',
  'JOIN sys.indexes i ON i.object_id = t.object_id',
  'LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id',
  'LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id',
  'WHERE t.is_ms_shipped = 0 AND i.index_id > 0',
  'ORDER BY s.name, t.name, i.name, ic.key_ordinal, ic.index_column_id;'
].join('\n');

const CONSTRAINTS_SQL = [
  "SELECT 'DEFAULT' AS constraint_type, s.name AS schema_name, t.name AS table_name,",
  '       dc.name AS constraint_name, c.name AS column_name, dc.definition,',
  '       NULL AS referenced_schema, NULL AS referenced_table, NULL AS referenced_column,',
  '       NULL AS delete_action, NULL AS update_action, NULL AS key_ordinal',
  'FROM sys.default_constraints dc',
  'JOIN sys.tables t ON t.object_id = dc.parent_object_id',
  'JOIN sys.schemas s ON s.schema_id = t.schema_id',
  'JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = dc.parent_column_id',
  'WHERE t.is_ms_shipped = 0',
  'UNION ALL',
  "SELECT 'CHECK', s.name, t.name, cc.name, NULL, cc.definition,",
  '       NULL, NULL, NULL, NULL, NULL, NULL',
  'FROM sys.check_constraints cc',
  'JOIN sys.tables t ON t.object_id = cc.parent_object_id',
  'JOIN sys.schemas s ON s.schema_id = t.schema_id',
  'WHERE t.is_ms_shipped = 0',
  'UNION ALL',
  "SELECT 'FOREIGN_KEY', ps.name, pt.name, fk.name, pc.name, NULL,",
  '       rs.name, rt.name, rc.name, fk.delete_referential_action_desc,',
  '       fk.update_referential_action_desc, fkc.constraint_column_id',
  'FROM sys.foreign_keys fk',
  'JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id',
  'JOIN sys.tables pt ON pt.object_id = fk.parent_object_id',
  'JOIN sys.schemas ps ON ps.schema_id = pt.schema_id',
  'JOIN sys.columns pc ON pc.object_id = pt.object_id AND pc.column_id = fkc.parent_column_id',
  'JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id',
  'JOIN sys.schemas rs ON rs.schema_id = rt.schema_id',
  'JOIN sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id',
  'WHERE pt.is_ms_shipped = 0',
  'ORDER BY schema_name, table_name, constraint_name, key_ordinal;'
].join('\n');

const MODULES_SQL = [
  'SELECT s.name AS schema_name, o.name AS object_name, o.type AS object_type, m.definition',
  'FROM sys.sql_modules m',
  'JOIN sys.objects o ON o.object_id = m.object_id',
  'JOIN sys.schemas s ON s.schema_id = o.schema_id',
  'WHERE o.is_ms_shipped = 0',
  'ORDER BY s.name, o.name, o.type;'
].join('\n');

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function stringValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return null;
}

function query(connection: SqlServerConnection, sql: string): Promise<SqlServerQueryResult> {
  return querySqlServer(connection, sql, undefined, { maxRows: MAX_ROWS, maxBytes: MAX_BYTES });
}

export async function readDatabaseDeploymentFingerprint(
  connectionId: string,
  connection: SqlServerConnection
): Promise<DatabaseDeploymentFingerprint> {
  const startedAt = Date.now();
  const capturedAt = new Date().toISOString();
  const [config, objects, columns, indexes, constraints, modules] = await Promise.all([
    query(connection, CONFIG_SQL),
    query(connection, OBJECTS_SQL),
    query(connection, COLUMNS_SQL),
    query(connection, INDEXES_SQL),
    query(connection, CONSTRAINTS_SQL),
    query(connection, MODULES_SQL)
  ]);
  const sections = [config, objects, columns, indexes, constraints, modules];
  const complete = sections.every(section => !section.truncated);
  const limitations: string[] = [];
  if (!complete) {
    limitations.push('Deployment fingerprint is incomplete because at least one catalog section exceeded its bound.');
  }
  const configuration = config.rows[0] ?? {};
  const schemaHash = complete ? digest([objects.rows, columns.rows, indexes.rows, constraints.rows]) : null;
  const moduleHash = !modules.truncated ? digest(modules.rows) : null;
  const configurationHash = !config.truncated ? digest(config.rows) : null;
  const fingerprint = schemaHash && moduleHash && configurationHash
    ? digest([schemaHash, moduleHash, configurationHash])
    : null;
  return {
    connection: connectionId,
    database: connection.database ?? '',
    capturedAt,
    complete,
    fingerprint,
    schemaHash,
    moduleHash,
    configurationHash,
    counts: {
      objects: objects.rows.length,
      columns: columns.rows.length,
      indexes: indexes.rows.length,
      constraints: constraints.rows.length,
      modules: modules.rows.length
    },
    configuration: {
      compatibilityLevel: numberValue(configuration.compatibility_level),
      collation: stringValue(configuration.collation_name),
      recoveryModel: stringValue(configuration.recovery_model_desc),
      readCommittedSnapshot: boolValue(configuration.is_read_committed_snapshot_on),
      snapshotIsolationState: stringValue(configuration.snapshot_isolation_state_desc)
    },
    limitations,
    elapsedMs: Date.now() - startedAt
  };
}
