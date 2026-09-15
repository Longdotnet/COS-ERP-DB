import {
  querySqlServer,
  type SqlServerConnection,
  type SqlServerQueryOptions,
  type SqlServerQueryResult
} from './sqlserver.js';
import type {
  DatabaseObjectSearchInput,
  DatabaseObjectSearchResult,
  DatabaseObjectSummary,
  DatabaseObjectType
} from '../../shared/database.js';

export type {
  DatabaseObjectSearchInput,
  DatabaseObjectSearchResult,
  DatabaseObjectSummary,
  DatabaseObjectType
} from '../../shared/database.js';

export const MAX_DATABASE_OBJECT_PAGE_SIZE = 100;
export const DEFAULT_DATABASE_OBJECT_PAGE_SIZE = 50;
export const MAX_DATABASE_OBJECT_SEARCH_CHARS = 128;
const METADATA_RESULT_BYTES = 256_000;

type MetadataQuery = (
  connection: SqlServerConnection,
  sql: string,
  options: SqlServerQueryOptions
) => Promise<SqlServerQueryResult>;

interface ObjectCursor {
  v: 1;
  schema: string;
  name: string;
  objectId: number;
  search: string;
  types: string;
}

const SQL_TYPES: Readonly<Record<DatabaseObjectType, readonly string[]>> = {
  table: ['U'],
  view: ['V'],
  procedure: ['P', 'PC'],
  function: ['FN', 'IF', 'TF', 'FS', 'FT'],
  synonym: ['SN']
};

const SQL_OBJECT_SEARCH = `
SELECT TOP (@take)
  s.name AS schema_name,
  o.name AS object_name,
  o.type AS sql_type,
  o.object_id,
  o.modify_date
FROM sys.objects AS o
INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.is_ms_shipped = 0
  AND o.type IN (__OBJECT_TYPES__)
  AND (
    @prefix = N'' OR
    o.name LIKE @prefix ESCAPE N'~' OR
    s.name LIKE @prefix ESCAPE N'~'
  )
  AND (
    @after_schema = N'' OR
    s.name > @after_schema OR
    (s.name = @after_schema AND o.name > @after_name) OR
    (s.name = @after_schema AND o.name = @after_name AND o.object_id > @after_id)
  )
ORDER BY s.name, o.name, o.object_id;`;

function normalizeSearch(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length > MAX_DATABASE_OBJECT_SEARCH_CHARS) {
    throw new Error(`Object search text is too long. Maximum length is ${MAX_DATABASE_OBJECT_SEARCH_CHARS} characters.`);
  }
  return normalized;
}

function normalizeTypes(types: readonly DatabaseObjectType[] | undefined): DatabaseObjectType[] {
  const selected = types?.length ? [...new Set(types)] : Object.keys(SQL_TYPES) as DatabaseObjectType[];
  selected.sort();
  return selected;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_DATABASE_OBJECT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DATABASE_OBJECT_PAGE_SIZE) {
    throw new Error(`Object page size must be an integer between 1 and ${MAX_DATABASE_OBJECT_PAGE_SIZE}.`);
  }
  return limit;
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[~%_\[]/g, match => `~${match}`) + '%';
}

function cursorFingerprint(search: string, types: readonly DatabaseObjectType[]): string {
  return `${search}\u0000${types.join(',')}`;
}

function encodeCursor(last: DatabaseObjectSummary, search: string, types: readonly DatabaseObjectType[]): string {
  const fingerprint = cursorFingerprint(search, types);
  const separator = fingerprint.indexOf('\u0000');
  const payload: ObjectCursor = {
    v: 1,
    schema: last.schema,
    name: last.name,
    objectId: last.objectId,
    search: fingerprint.slice(0, separator),
    types: fingerprint.slice(separator + 1)
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined, search: string, types: readonly DatabaseObjectType[]): ObjectCursor | null {
  if (!value) return null;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Object cursor is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Object cursor is invalid.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Object cursor is invalid.');
  const row = parsed as Partial<ObjectCursor>;
  if (
    row.v !== 1 ||
    typeof row.schema !== 'string' || row.schema.length > 128 ||
    typeof row.name !== 'string' || row.name.length > 128 ||
    !Number.isInteger(row.objectId) || (row.objectId ?? 0) <= 0 ||
    row.search !== search || row.types !== types.join(',')
  ) {
    throw new Error('Object cursor does not match the current search and type filters.');
  }
  return row as ObjectCursor;
}

function sqlTypeList(types: readonly DatabaseObjectType[]): string {
  return types.flatMap(type => SQL_TYPES[type]).map(type => `'${type}'`).join(', ');
}

function objectType(sqlType: unknown): DatabaseObjectType | null {
  if (typeof sqlType !== 'string') return null;
  const normalized = sqlType.trim();
  if (SQL_TYPES.table.includes(normalized)) return 'table';
  if (SQL_TYPES.view.includes(normalized)) return 'view';
  if (SQL_TYPES.procedure.includes(normalized)) return 'procedure';
  if (SQL_TYPES.function.includes(normalized)) return 'function';
  if (SQL_TYPES.synonym.includes(normalized)) return 'synonym';
  return null;
}

function rowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function rowNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export async function searchSqlServerObjects(
  connection: SqlServerConnection,
  input: DatabaseObjectSearchInput,
  options: { signal?: AbortSignal } = {},
  query: MetadataQuery = (resolved, sql, queryOptions) => querySqlServer(resolved, sql, undefined, queryOptions)
): Promise<DatabaseObjectSearchResult> {
  const search = normalizeSearch(input.search);
  const types = normalizeTypes(input.types);
  const limit = normalizeLimit(input.limit);
  const cursor = decodeCursor(input.cursor, search, types);
  const take = limit + 1;
  const sql = SQL_OBJECT_SEARCH.replace('__OBJECT_TYPES__', sqlTypeList(types));
  const result = await query(connection, sql, {
    maxRows: take,
    maxBytes: METADATA_RESULT_BYTES,
    ...(options.signal ? { signal: options.signal } : {}),
    parameters: {
      take,
      prefix: search === '' ? '' : escapeLikePrefix(search),
      after_schema: cursor?.schema ?? '',
      after_name: cursor?.name ?? '',
      after_id: cursor?.objectId ?? 0
    }
  });

  const mapped: DatabaseObjectSummary[] = [];
  for (const row of result.rows) {
    const schema = rowString(row, 'schema_name');
    const name = rowString(row, 'object_name');
    const type = objectType(row.sql_type);
    const objectId = rowNumber(row, 'object_id');
    const modified = row.modify_date;
    if (!schema || !name || !type || objectId === null) throw new Error('SQL Server returned malformed object metadata.');
    mapped.push({
      schema,
      name,
      type,
      objectId,
      modifiedAt: typeof modified === 'string' ? modified : modified instanceof Date ? modified.toISOString() : null
    });
  }
  const hasMore = mapped.length > limit || result.truncated;
  const objects = mapped.slice(0, limit);
  const last = objects.at(-1);
  return {
    objects,
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeCursor(last, search, types) } : {}),
    elapsedMs: result.elapsedMs
  };
}
