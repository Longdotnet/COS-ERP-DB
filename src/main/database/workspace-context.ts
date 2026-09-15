import type { DatabaseWorkspaceContext, DatabaseWorkspaceContextInput } from '../../shared/database.js';

export const MAX_DATABASE_CONTEXT_SELECTED_ROWS = 10;
const MAX_CONTEXT_ROW_COLUMNS = 64;
const MAX_CONTEXT_STRING_CHARS = 4_000;
const MAX_CONTEXT_VALUE_DEPTH = 4;

let current: DatabaseWorkspaceContext | null = null;

function safeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'string') return value.length > MAX_CONTEXT_STRING_CHARS ? `${value.slice(0, MAX_CONTEXT_STRING_CHARS)}…` : value;
  if (depth >= MAX_CONTEXT_VALUE_DEPTH) return String(value);
  if (Array.isArray(value)) return value.slice(0, 32).map(entry => safeValue(entry, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_CONTEXT_ROW_COLUMNS)) {
      result[key.slice(0, 256)] = safeValue(entry, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, MAX_CONTEXT_STRING_CHARS);
}

function safeRows(rows: readonly Record<string, unknown>[] | undefined): { rows?: Record<string, unknown>[]; truncated: boolean } {
  if (!rows?.length) return { truncated: false };
  const kept = rows.slice(0, MAX_DATABASE_CONTEXT_SELECTED_ROWS).map(row => safeValue(row) as Record<string, unknown>);
  return { rows: kept, truncated: rows.length > kept.length };
}

/** Ephemeral only: this context is intentionally never written to disk or credential storage. */
export function setDatabaseWorkspaceContext(input: DatabaseWorkspaceContextInput | null): DatabaseWorkspaceContext | null {
  if (!input) {
    current = null;
    return null;
  }
  const selected = safeRows(input.selectedRows);
  current = {
    connection: input.connection,
    ...(input.object ? { object: { ...input.object } } : {}),
    ...(input.tab ? { tab: input.tab } : {}),
    ...(input.filters?.length ? { filters: input.filters.map(filter => ({ ...filter })) } : {}),
    ...(input.sort ? { sort: { ...input.sort } } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(selected.rows ? { selectedRows: selected.rows } : {}),
    selectedRowsTruncated: selected.truncated,
    updatedAt: Date.now()
  };
  return getDatabaseWorkspaceContext();
}

export function getDatabaseWorkspaceContext(): DatabaseWorkspaceContext | null {
  return current ? structuredClone(current) : null;
}

export function resetDatabaseWorkspaceContextForTests(): void {
  current = null;
}
