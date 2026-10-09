import type { KnowledgeEvidence, KnowledgeEvidenceLocator } from './contracts/knowledge.js';
import type { DatabaseObjectSummary, DatabaseObjectType } from '../../shared/database.js';
import { searchSqlServerObjects } from '../../main/database/metadata.js';
import { resolveSqlServerProfile } from '../../main/database/profiles.js';
import { querySqlServer } from '../../main/database/sqlserver.js';
import type { SqlServerConnection } from '../../main/database/sqlserver.js';
import { chunkKnowledgeText, createKnowledgeEvidence, knowledgeSha256 } from './evidence.js';

const MAX_DATABASE_OBJECTS = 10_000;
const MAX_DATABASE_COLUMNS = 60_000;
const MAX_DATABASE_MODULE_BYTES = 20 * 1024 * 1024;

const COLUMNS_SQL = [
  'SELECT c.object_id, c.column_id, c.name AS column_name,',
  'TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.precision, c.scale,',
  'c.is_nullable, c.is_identity, c.is_computed',
  'FROM sys.columns AS c',
  'INNER JOIN sys.objects AS o ON o.object_id = c.object_id',
  'WHERE o.is_ms_shipped = 0',
  'ORDER BY c.object_id, c.column_id;'
].join('\n');

const MODULES_SQL = [
  'SELECT o.object_id, m.definition',
  'FROM sys.sql_modules AS m',
  'INNER JOIN sys.objects AS o ON o.object_id = m.object_id',
  'WHERE o.is_ms_shipped = 0',
  'ORDER BY o.object_id;'
].join('\n');

const ONE_OBJECT_SQL = [
  'SELECT o.object_id, s.name AS schema_name, o.name AS object_name,',
  'o.type AS sql_type, o.modify_date, m.definition',
  'FROM sys.objects AS o',
  'INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id',
  'LEFT JOIN sys.sql_modules AS m ON m.object_id = o.object_id',
  'WHERE o.is_ms_shipped = 0 AND o.object_id = @object_id;'
].join('\n');

const ONE_OBJECT_COLUMNS_SQL = [
  'SELECT c.object_id, c.column_id, c.name AS column_name,',
  'TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.precision, c.scale,',
  'c.is_nullable, c.is_identity, c.is_computed',
  'FROM sys.columns AS c',
  'WHERE c.object_id = @object_id',
  'ORDER BY c.column_id;'
].join('\n');

interface DatabaseColumnInfo {
  columnId: number;
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
  nullable: boolean;
  identity: boolean;
  computed: boolean;
}

function normalizedOriginPart(value: string | number | undefined): string {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

/** Stable database origin without credentials; safe to persist in provenance metadata. */
export function databaseOriginFingerprint(profileId: string, connection: SqlServerConnection): string {
  return knowledgeSha256([
    normalizedOriginPart(profileId),
    normalizedOriginPart(connection.server),
    normalizedOriginPart(connection.instanceName),
    normalizedOriginPart(connection.port),
    normalizedOriginPart(connection.database)
  ].join('|'));
}

export interface IndexedDatabaseKnowledgeSource {
  kind: 'database';
  sourceKey: string;
  evidence: KnowledgeEvidence[];
  limitations: string[];
}

function rowNumber(row: Record<string, unknown>, name: string): number | null {
  return typeof row[name] === 'number' && Number.isFinite(row[name]) ? Number(row[name]) : null;
}

function rowString(row: Record<string, unknown>, name: string): string | null {
  return typeof row[name] === 'string' ? row[name] as string : null;
}

function rowBoolean(row: Record<string, unknown>, name: string): boolean {
  const value = row[name];
  return value === true || value === 1;
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
  }
  return null;
}

function objectType(sqlType: unknown): DatabaseObjectType | null {
  if (typeof sqlType !== 'string') return null;
  if (sqlType === 'U') return 'table';
  if (sqlType === 'V') return 'view';
  if (sqlType === 'P' || sqlType === 'PC') return 'procedure';
  if (['FN', 'IF', 'TF', 'FS', 'FT'].includes(sqlType)) return 'function';
  if (sqlType === 'SN') return 'synonym';
  return null;
}

function mapColumn(row: Record<string, unknown>): DatabaseColumnInfo | null {
  const columnId = rowNumber(row, 'column_id');
  const name = rowString(row, 'column_name');
  const type = rowString(row, 'type_name');
  if (columnId === null || !name || !type) return null;
  return {
    columnId,
    name,
    type,
    maxLength: rowNumber(row, 'max_length') ?? 0,
    precision: rowNumber(row, 'precision') ?? 0,
    scale: rowNumber(row, 'scale') ?? 0,
    nullable: rowBoolean(row, 'is_nullable'),
    identity: rowBoolean(row, 'is_identity'),
    computed: rowBoolean(row, 'is_computed')
  };
}

function formatColumn(column: DatabaseColumnInfo): string {
  const shape = column.precision > 0
    ? column.type + '(' + column.precision + ',' + column.scale + ')'
    : column.maxLength > 0
      ? column.type + '(' + column.maxLength + ')'
      : column.type;
  const flags = [
    column.nullable ? 'nullable' : 'required',
    column.identity ? 'identity' : '',
    column.computed ? 'computed' : ''
  ].filter(Boolean).join(',');
  return column.columnId + '. ' + column.name + ' ' + shape + ' [' + flags + ']';
}

function objectSourceText(
  object: DatabaseObjectSummary,
  columns: readonly DatabaseColumnInfo[],
  definition: string | null
): string {
  const header = [
    'type=' + object.type,
    'schema=' + object.schema,
    'name=' + object.name,
    'objectId=' + object.objectId,
    'modifiedAt=' + (object.modifiedAt ?? '')
  ].join('\n');
  const columnText = columns.length ? '\ncolumns:\n' + columns.map(formatColumn).join('\n') : '';
  const moduleText = definition ? '\ndefinition:\n' + definition : '';
  return header + columnText + moduleText;
}

async function listObjects(connection: Awaited<ReturnType<typeof resolveSqlServerProfile>>['connection']): Promise<{
  objects: DatabaseObjectSummary[];
  truncated: boolean;
}> {
  const objects: DatabaseObjectSummary[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const page = await searchSqlServerObjects(connection, { search: '', limit: 100, ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    if (objects.length >= MAX_DATABASE_OBJECTS) {
      objects.splice(MAX_DATABASE_OBJECTS);
      truncated = page.hasMore;
      break;
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (cursor);
  return { objects, truncated };
}

function locatorFor(
  connection: string,
  database: string,
  databaseOrigin: string,
  object: DatabaseObjectSummary,
  part: string
): KnowledgeEvidenceLocator {
  return {
    connection,
    database,
    databaseOrigin,
    objectId: object.objectId,
    objectType: object.type,
    schema: object.schema,
    name: object.name,
    part
  };
}

function evidenceForObject(input: {
  scope: string;
  sourceKey: string;
  connection: string;
  database: string;
  databaseOrigin: string;
  object: DatabaseObjectSummary;
  columns: readonly DatabaseColumnInfo[];
  definition: string | null;
  capturedAt: string;
}): KnowledgeEvidence[] {
  const sourceText = objectSourceText(input.object, input.columns, input.definition);
  const sourceHash = knowledgeSha256(sourceText);
  const headerAndColumns = objectSourceText(input.object, input.columns, null);
  const title = input.object.type + ' ' + input.object.schema + '.' + input.object.name;
  const evidence = [createKnowledgeEvidence({
    scope: input.scope,
    kind: 'database',
    sourceKey: input.sourceKey,
    title,
    content: headerAndColumns,
    sourceHash,
    capturedAt: input.capturedAt,
    locator: locatorFor(input.connection, input.database, input.databaseOrigin, input.object, 'metadata'),
    sourceSize: Buffer.byteLength(sourceText, 'utf8')
  })];
  if (input.definition) {
    const chunks = chunkKnowledgeText(input.definition);
    for (const [index, chunk] of chunks.entries()) {
      evidence.push(createKnowledgeEvidence({
        scope: input.scope,
        kind: 'database',
        sourceKey: input.sourceKey,
        title,
        content: chunk.content,
        sourceHash,
        capturedAt: input.capturedAt,
        locator: locatorFor(input.connection, input.database, input.databaseOrigin, input.object, 'definition ' + (index + 1)),
        sourceSize: Buffer.byteLength(sourceText, 'utf8')
      }));
    }
  }
  return evidence;
}

export async function indexKnowledgeDatabase(scope: string, requestedConnection?: string): Promise<IndexedDatabaseKnowledgeSource> {
  const profile = await resolveSqlServerProfile(requestedConnection);
  const database = profile.connection.database ?? '';
  const databaseOrigin = databaseOriginFingerprint(profile.id, profile.connection);
  const sourceKey = 'database:' + profile.id + ':' + database;
  const capturedAt = new Date().toISOString();
  const limitations: string[] = [];
  const listed = await listObjects(profile.connection);
  if (listed.truncated) limitations.push('Database object catalog was capped at ' + MAX_DATABASE_OBJECTS.toLocaleString('en-US') + ' objects.');

  const [columnsResult, modulesResult] = await Promise.all([
    querySqlServer(profile.connection, COLUMNS_SQL, undefined, {
      maxRows: MAX_DATABASE_COLUMNS,
      maxBytes: 12 * 1024 * 1024
    }),
    querySqlServer(profile.connection, MODULES_SQL, undefined, {
      maxRows: MAX_DATABASE_OBJECTS,
      maxBytes: MAX_DATABASE_MODULE_BYTES
    })
  ]);
  if (columnsResult.truncated) limitations.push('Column metadata was capped at ' + MAX_DATABASE_COLUMNS.toLocaleString('en-US') + ' rows / 12 MiB.');
  if (modulesResult.truncated) limitations.push('SQL module text was capped at 20 MiB; later module definitions may require live database lookup.');

  const columns = new Map<number, DatabaseColumnInfo[]>();
  for (const row of columnsResult.rows) {
    const objectId = rowNumber(row, 'object_id');
    const column = mapColumn(row);
    if (objectId === null || !column) continue;
    const existing = columns.get(objectId) ?? [];
    existing.push(column);
    columns.set(objectId, existing);
  }
  const definitions = new Map<number, string>();
  for (const row of modulesResult.rows) {
    const objectId = rowNumber(row, 'object_id');
    const definition = rowString(row, 'definition');
    if (objectId !== null && definition) definitions.set(objectId, definition);
  }

  const evidence = listed.objects.flatMap(object => evidenceForObject({
    scope,
    sourceKey,
    connection: profile.id,
    database,
    databaseOrigin,
    object,
    columns: columns.get(object.objectId) ?? [],
    definition: definitions.get(object.objectId) ?? null,
    capturedAt
  }));
  return { kind: 'database', sourceKey, evidence, limitations };
}

export async function currentDatabaseEvidenceSourceHash(locator: KnowledgeEvidenceLocator): Promise<string | null> {
  if (!locator.connection || !locator.objectId) return null;
  const profile = await resolveSqlServerProfile(locator.connection);
  const currentDatabase = profile.connection.database ?? '';
  if (locator.databaseOrigin) {
    if (locator.databaseOrigin !== databaseOriginFingerprint(profile.id, profile.connection)) return null;
  } else {
    if (typeof locator.database !== 'string') return null;
    if (normalizedOriginPart(locator.database) !== normalizedOriginPart(currentDatabase)) return null;
  }
  const [objectResult, columnsResult] = await Promise.all([
    querySqlServer(profile.connection, ONE_OBJECT_SQL, undefined, {
      maxRows: 1,
      maxBytes: 4 * 1024 * 1024,
      parameters: { object_id: locator.objectId }
    }),
    querySqlServer(profile.connection, ONE_OBJECT_COLUMNS_SQL, undefined, {
      maxRows: 2_000,
      maxBytes: 2 * 1024 * 1024,
      parameters: { object_id: locator.objectId }
    })
  ]);
  const row = objectResult.rows[0];
  if (!row) return null;
  const type = objectType(row.sql_type);
  const schema = rowString(row, 'schema_name');
  const name = rowString(row, 'object_name');
  if (!type || !schema || !name) return null;
  const object: DatabaseObjectSummary = {
    objectId: locator.objectId,
    type,
    schema,
    name,
    modifiedAt: isoDate(row.modify_date)
  };
  const columns = columnsResult.rows.map(mapColumn).filter((value): value is DatabaseColumnInfo => value !== null);
  const definition = rowString(row, 'definition');
  return knowledgeSha256(objectSourceText(object, columns, definition));
}
