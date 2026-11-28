import { createHash } from 'node:crypto';
import type { DatabaseActionInput, DatabaseActionOutput } from '../../main/database/service.js';
import { investigateBusinessObject } from './business-trace.js';

type Execute = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
type Trace = Awaited<ReturnType<typeof investigateBusinessObject>>;
const MAX_COMPARED_OBJECTS = 6;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

function rowsSignature(rows: Array<Record<string, unknown>>) {
  return rows.map(canonical).sort().join('\n');
}

function summarize(trace: Trace) {
  return { connection: trace.connection, database: trace.database, capturedAt: trace.capturedAt, truncated: trace.truncated };
}

export async function compareBusinessObject(
  request: { connection: string; baselineConnection: string; search: string },
  execute: Execute,
  signal?: AbortSignal
) {
  if (request.connection.toLowerCase() === request.baselineConnection.toLowerCase()) {
    throw new Error('Choose two different database connections.');
  }
  // Resolve and trace each database independently; object IDs never cross the connection boundary.
  const [baseline, current] = await Promise.all([
    investigateBusinessObject({ connection: request.baselineConnection, search: request.search }, execute, signal),
    investigateBusinessObject({ connection: request.connection, search: request.search }, execute, signal)
  ]);
  const metadataDifferences = [];
  for (const table of new Set([...baseline.inspected, ...current.inspected, ...baseline.unavailable, ...current.unavailable])) {
    const left = baseline.metadata.find(m => m.table === table);
    const right = current.metadata.find(m => m.table === table);
    const baselineAvailable = baseline.inspected.includes(table);
    const currentAvailable = current.inspected.includes(table);
    if (!baselineAvailable || !currentAvailable) {
      if (baselineAvailable !== currentAvailable) metadataDifferences.push({ table, status: 'coverage-differs', baselineAvailable, currentAvailable });
      continue;
    }
    if (left?.truncated || right?.truncated || baseline.truncated || current.truncated) {
      metadataDifferences.push({ table, status: 'incomplete', baseline: left?.rows ?? [], current: right?.rows ?? [] });
    } else if (rowsSignature(left?.rows ?? []) !== rowsSignature(right?.rows ?? [])) {
      metadataDifferences.push({ table, status: 'different', baseline: left?.rows ?? [], current: right?.rows ?? [] });
    }
  }

  const objectKey = (row: Record<string, unknown>) => String(row.Schema) + '.' + String(row.Name);
  const leftObjects = new Map(baseline.objects.map(row => [objectKey(row), row]));
  const rightObjects = new Map(current.objects.map(row => [objectKey(row), row]));
  const keys = [...new Set([...leftObjects.keys(), ...rightObjects.keys()])];
  const objects = [];
  let compared = 0;
  for (const key of keys) {
    const left = leftObjects.get(key);
    const right = rightObjects.get(key);
    if (!left || !right) {
      objects.push({ object: key, status: 'observed-on-one-side', baseline: left ?? null, current: right ?? null });
      continue;
    }
    if (left.Type !== right.Type) {
      objects.push({ object: key, status: 'type-different', baseline: left.Type, current: right.Type });
      continue;
    }
    if (compared >= MAX_COMPARED_OBJECTS) {
      objects.push({ object: key, status: 'not-compared-budget' });
      continue;
    }
    compared++;
    const section = ['USER_TABLE', 'VIEW'].includes(String(left.Type)) ? 'columns' as const : 'ddl' as const;
    if (typeof left.ObjectId !== 'number' || typeof right.ObjectId !== 'number') {
      objects.push({ object: key, status: 'unavailable' });
      continue;
    }
    const [a, b] = await Promise.all([
      execute({ action: 'object_details', connection: baseline.connection, objectId: left.ObjectId, section }, signal ? { signal } : undefined),
      execute({ action: 'object_details', connection: current.connection, objectId: right.ObjectId, section }, signal ? { signal } : undefined)
    ]);
    if (a.action !== 'object_details' || b.action !== 'object_details' ||
      a.connection !== baseline.connection || b.connection !== current.connection ||
      a.database !== baseline.database || b.database !== current.database ||
      a.schema + '.' + a.name !== key || b.schema + '.' + b.name !== key) {
      throw new Error('Object or database identity changed during comparison.');
    }
    if (a.truncated || b.truncated) {
      objects.push({ object: key, status: 'incomplete' });
      continue;
    }
    if (section === 'columns' && a.columns && b.columns) {
      const aa = new Map(a.columns.map(c => [c.name, c]));
      const bb = new Map(b.columns.map(c => [c.name, c]));
      const differences = [...new Set([...aa.keys(), ...bb.keys()])].flatMap(name => {
        const oldColumn = aa.get(name) ?? null;
        const newColumn = bb.get(name) ?? null;
        return canonical(oldColumn) === canonical(newColumn) ? [] : [{ column: name, baseline: oldColumn, current: newColumn }];
      });
      objects.push({ object: key, status: differences.length ? 'different' : 'same', section, differenceCount: differences.length, differences: differences.slice(0, 50), truncated: differences.length > 50 });
    } else if (section === 'ddl' && a.ddl?.complete && b.ddl?.complete && !a.ddl.truncated && !b.ddl.truncated && a.ddl.kind !== 'unavailable' && b.ddl.kind !== 'unavailable') {
      const hash = (value: string) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
      const baselineHash = hash(a.ddl.text);
      const currentHash = hash(b.ddl.text);
      objects.push({ object: key, status: baselineHash === currentHash ? 'same' : 'different', section, baselineHash, currentHash });
    } else {
      objects.push({ object: key, status: 'unavailable' });
    }
  }
  const dependencyKey = (row: Record<string, unknown>) => canonical({
    from: [row.FromSchema, row.FromName],
    to: [row.ToServer, row.ToDatabase, row.ToSchema, row.ToName],
    resolved: row.ToObjectId != null,
    ambiguous: row.Ambiguous
  });
  const leftDependencies = new Map(baseline.dependencies.map(row => [dependencyKey(row), row]));
  const rightDependencies = new Map(current.dependencies.map(row => [dependencyKey(row), row]));
  const dependencyDifferences = {
    baselineOnly: [...leftDependencies].filter(([key]) => !rightDependencies.has(key)).map(([, row]) => row),
    currentOnly: [...rightDependencies].filter(([key]) => !leftDependencies.has(key)).map(([, row]) => row)
  };
  return {
    search: request.search, baseline: summarize(baseline), current: summarize(current),
    metadataDifferences, objects, dependencyDifferences,
    limitations: [
      ...new Set([...baseline.limitations, ...current.limitations]),
      'Comparison covers discovered objects only, matches exact schema/name, and does not prove absence outside the selected scope.',
      'DDL fingerprints compare source text (normalized line endings), not semantic equivalence. Column comparison does not include indexes.',
      'One-sided dependencies are observations, not confirmed removals or additions when a trace is incomplete.'
    ]
  };
}
