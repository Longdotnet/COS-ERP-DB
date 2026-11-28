import { createHash } from 'node:crypto';
import { assertReadOnlySql, type DatabaseActionInput, type DatabaseActionOutput } from '../../main/database/service.js';
import { z } from 'zod';

type Execute = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const connection = z.string().trim().min(1).max(64);
const select = z.string().trim().min(1).max(32000);
export const resultCompareSchema = z.object({
  baseline: z.object({ connection, sql: select }).strict(),
  candidate: z.object({ connection, sql: select }).strict()
}).strict();

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k,v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'undefined';
}
export async function compareQueryResults(input: z.infer<typeof resultCompareSchema>, execute: Execute, signal?: AbortSignal) {
  // Validate both before either runs; never execute SPs or deploy SQL through this action.
  assertReadOnlySql(input.baseline.sql);
  assertReadOnlySql(input.candidate.sql);
  const read = async (request: typeof input.baseline) => {
    signal?.throwIfAborted();
    const r = await execute({ action: 'query', ...request }, { signal });
    if (r.action !== 'query') throw new Error('Unexpected comparison response');
    return r;
  };
  const a = await read(input.baseline);
  const b = await read(input.candidate);
  if (input.baseline.connection.toLowerCase() === input.candidate.connection.toLowerCase()
    && (a.connection !== b.connection || a.database !== b.database)) throw new Error('Database identity changed during comparison.');
  const shape = (r: typeof a) => r.columns.map(c => ({ name: c.name, type: c.type, nullable: c.nullable }));
  const leftShape = shape(a), rightShape = shape(b);
  const duplicateColumns = (cols: typeof leftShape) => new Set(cols.map(c => c.name.toLowerCase())).size !== cols.length;
  const unrepresentable = (r: typeof a) => r.rows.some(row => r.columns.some(c => !Object.hasOwn(row,c.name) || Array.isArray(row[c.name])));
  const sameShape = stable(leftShape) === stable(rightShape);
  const coverage = a.truncated || b.truncated || duplicateColumns(leftShape) || duplicateColumns(rightShape) || unrepresentable(a) || unrepresentable(b);
  const bag = (r: typeof a) => {
    const counts = new Map<string, number>();
    for (const row of r.rows) {
      const digest = hash(stable(r.columns.map(c => row[c.name])));
      counts.set(digest,(counts.get(digest) ?? 0) + 1);
    }
    return counts;
  };
  const left = bag(a), right = bag(b);
  const unmatched = (x: Map<string,number>, y: Map<string,number>) => [...x].reduce((n,[key,count]) => n + Math.max(0,count-(y.get(key)??0)),0);
  const leftOnly = unmatched(left,right), rightOnly = unmatched(right,left);
  return {
    status: coverage ? 'incomplete' : !sameShape || leftOnly || rightOnly ? 'different' : 'same-observed-results',
    sameShape, schema: { baseline: leftShape, candidate: rightShape },
    baseline: { connection: a.connection, database: a.database, rows: a.rows.length, truncated: a.truncated, elapsedMs: a.elapsedMs },
    candidate: { connection: b.connection, database: b.database, rows: b.rows.length, truncated: b.truncated, elapsedMs: b.elapsedMs },
    unmatchedRows: sameShape && !coverage ? { baseline: leftOnly, candidate: rightOnly } : null,
    limitations: ['Only returned SELECT results for these exact inputs; duplicate rows count and order is ignored.', 'Provider row/byte limits, duplicate column aliases or missing values prevent an equality conclusion.', 'Separate executions are not an atomic snapshot; numeric precision is limited to the SQL driver representation.', 'Elapsed times are observations, not a controlled performance benchmark. No general procedure equivalence or deployment is established.']
  };
}

export const objectVerificationSchema = z.object({
  connection, object: z.string().trim().min(1).max(257).regex(/^[\p{L}\p{N}_$#]+\.[\p{L}\p{N}_$#]+$/u),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
}).strict();

export async function verifyDeployedObject(input: z.infer<typeof objectVerificationSchema>, execute: Execute, signal?: AbortSignal) {
  const [schema,name] = input.object.split('.');
  const literal = (s: string) => "N'" + s.replace(/'/g,"''") + "'";
  const result = await execute({ action: 'query', connection: input.connection,
    sql: `SELECT o.object_id AS ObjectId,s.name AS [Schema],o.name AS Name,o.type_desc AS Type,o.modify_date AS ModifiedAt FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=${literal(schema!)} AND o.name=${literal(name!)}` },{ signal });
  if(result.action !== 'query') throw new Error('Unexpected SQL object response');
  const observed = result.rows[0];
  const id = observed?.ObjectId;
  const identity = { connection: result.connection, database: result.database, object: input.object, capturedAt: new Date().toISOString() };
  if(result.truncated || result.rows.length !== 1 || !observed || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return { ...identity, status: 'not-resolved', runtimeVerified: false };
  const details = await execute({ action: 'object_details', connection: result.connection, objectId: id, section: 'ddl' },{ signal });
  if(details.action !== 'object_details' || details.database !== result.database || details.connection !== result.connection || details.schema !== observed.Schema || details.name !== observed.Name) throw new Error('Object identity changed during verification');
  const ddl = details.ddl;
  if(!ddl?.complete || ddl.truncated || details.truncated || ddl.kind !== 'source') return { ...identity, status: 'definition-unavailable', runtimeVerified: false };
  const sha256 = hash(ddl.text.replace(/\r\n/g,'\n'));
  return { ...identity, status: input.expectedSha256 ? sha256 === input.expectedSha256.toLowerCase() ? 'definition-matches' : 'definition-differs' : 'definition-observed',
    sha256, expectedSha256: input.expectedSha256 ?? null, modifiedAt: observed.ModifiedAt, runtimeVerified: false,
    limitations: ['Exact definition fingerprint (LF normalized), not semantic equivalence. A matching SQL definition is not proof of successful application deployment or runtime testing.'] };
}
