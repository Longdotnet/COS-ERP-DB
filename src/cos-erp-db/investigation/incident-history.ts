import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DatabaseIncidentHistoryResult, DatabaseIncidentSnapshot } from './types.js';

const FILE_NAME = 'database-incident-history.json';
const MAX_INCIDENTS_PER_CONNECTION = 24;
const MAX_INCIDENT_REQUESTS = 80;
const MAX_SQL_TEXT_CHARS = 8_000;
let historyPath = '';
let mutationQueue: Promise<void> = Promise.resolve();

const liveRequestV1Schema = z.object({
  sessionId: z.number().int().nonnegative(), status: z.string(), command: z.string(), database: z.string().nullable(),
  login: z.string().nullable(), host: z.string().nullable(), program: z.string().nullable(), elapsedMs: z.number().finite().nonnegative(),
  cpuMs: z.number().finite().nonnegative(), logicalReads: z.number().finite().nonnegative(), writes: z.number().finite().nonnegative(),
  waitType: z.string().nullable(), waitMs: z.number().finite().nonnegative(), blockingSessionId: z.number().int(),
  openTransactionCount: z.number().int().nonnegative(), sql: z.string().nullable()
}).strict();

const liveRequestV2Schema = z.object({
  sessionId: z.number().int().nonnegative(), status: z.string(), command: z.string(), database: z.string().nullable(),
  login: z.string().nullable(), host: z.string().nullable(), program: z.string().nullable(), elapsedMs: z.number().finite().nonnegative(),
  cpuMs: z.number().finite().nonnegative(), logicalReads: z.number().finite().nonnegative(), writes: z.number().finite().nonnegative(),
  waitType: z.string().nullable(), lastWaitType: z.string().nullable(), waitMs: z.number().finite().nonnegative(), waitResource: z.string().nullable(),
  blockingSessionId: z.number().int(), openTransactionCount: z.number().int().nonnegative(),
  transactionBeginTime: z.string().datetime().nullable(), transactionAgeSeconds: z.number().finite().nonnegative().nullable(),
  queryHash: z.string().max(128).nullable(), queryPlanHash: z.string().max(128).nullable(),
  isBlocked: z.boolean(), isBlocker: z.boolean(), isRootBlocker: z.boolean(), isSleepingTransaction: z.boolean(),
  reasonMask: z.number().int().nonnegative(), sql: z.string().max(MAX_SQL_TEXT_CHARS).nullable()
}).strict();

const jobSchema = z.object({
  name: z.string(), enabled: z.boolean(), lastRunAt: z.string().nullable(),
  lastOutcome: z.enum(['succeeded', 'failed', 'retry', 'canceled', 'in-progress', 'unknown']),
  lastMessage: z.string().nullable(), lastDurationSeconds: z.number().finite().nonnegative().nullable(), nextRunAt: z.string().nullable()
}).strict();

const summarySchema = z.object({
  totalMb: z.number().finite().nonnegative().nullable(),
  dataUsedMb: z.number().finite().nonnegative().nullable(),
  logUsedPercent: z.number().finite().nonnegative().nullable(),
  activeRequestCount: z.number().int().nonnegative(),
  blockedRequestCount: z.number().int().nonnegative(),
  failedJobCount: z.number().int().nonnegative().nullable()
}).strict();

const findingSchema = z.object({ severity: z.string(), title: z.string(), detail: z.string() }).strict();

const snapshotV1Schema = z.object({
  id: z.string().uuid(),
  connection: z.string().min(1).max(64),
  database: z.string().max(256),
  capturedAt: z.string().datetime(),
  savedAt: z.string().datetime(),
  summary: summarySchema,
  requests: z.array(liveRequestV1Schema).max(40),
  jobs: z.array(jobSchema).max(200),
  findings: z.array(findingSchema).max(64),
  limitations: z.array(z.string()).max(64)
}).strict();

const snapshotV2Schema = z.object({
  id: z.string().uuid(),
  connection: z.string().min(1).max(64),
  database: z.string().max(256),
  capturedAt: z.string().datetime(),
  savedAt: z.string().datetime().nullable(),
  summary: summarySchema,
  requests: z.array(liveRequestV2Schema).max(MAX_INCIDENT_REQUESTS),
  jobs: z.array(jobSchema).max(200),
  findings: z.array(findingSchema).max(64),
  limitations: z.array(z.string()).max(64)
}).strict();

const historyV1Schema = z.object({
  version: z.literal(1),
  snapshots: z.array(snapshotV1Schema).max(32 * MAX_INCIDENTS_PER_CONNECTION)
}).strict();

const historyV2Schema = z.object({
  version: z.literal(2),
  snapshots: z.array(snapshotV2Schema).max(32 * MAX_INCIDENTS_PER_CONNECTION)
}).strict();

type SnapshotV1 = z.infer<typeof snapshotV1Schema>;
type LiveRequestV1 = z.infer<typeof liveRequestV1Schema>;
type HistoryFile = { version: 2; snapshots: DatabaseIncidentSnapshot[] };

export function initDatabaseIncidentHistory(userDataDir: string): void {
  historyPath = path.join(userDataDir, FILE_NAME);
}

function filePath(): string {
  if (!historyPath) throw new Error('Database incident history store is not initialized');
  return historyPath;
}

async function readFile(): Promise<HistoryFile> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(filePath(), 'utf8'));
    const current = historyV2Schema.safeParse(raw);
    if (current.success) return current.data as HistoryFile;
    const legacy = historyV1Schema.safeParse(raw);
    if (legacy.success) return { version: 2, snapshots: legacy.data.snapshots.map(migrateSnapshotV1) };
    throw new Error(current.error.message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, snapshots: [] };
    throw new Error(`Database incident history could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeFile(value: HistoryFile): Promise<void> {
  const target = filePath();
  const parsed = historyV2Schema.parse(value);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

function migrateLiveRequestV1(request: LiveRequestV1): DatabaseIncidentSnapshot['requests'][number] {
  return {
    ...request,
    lastWaitType: null,
    waitResource: null,
    transactionBeginTime: null,
    transactionAgeSeconds: null,
    queryHash: null,
    queryPlanHash: null,
    isBlocked: request.blockingSessionId !== 0,
    isBlocker: false,
    isRootBlocker: false,
    isSleepingTransaction: false,
    reasonMask: 0,
    sql: request.sql?.slice(0, MAX_SQL_TEXT_CHARS) ?? null
  };
}

function migrateSnapshotV1(snapshot: SnapshotV1): DatabaseIncidentSnapshot {
  return {
    ...snapshot,
    requests: snapshot.requests.map(migrateLiveRequestV1)
  };
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function key(connection: string): string {
  const value = connection.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error('Invalid database connection id');
  return value.toLowerCase();
}

export async function readDatabaseIncidentHistory(connection: string): Promise<DatabaseIncidentHistoryResult> {
  const connectionKey = key(connection);
  const file = await readFile();
  return {
    connection,
    snapshots: file.snapshots
      .filter(snapshot => snapshot.connection.toLowerCase() === connectionKey)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)) as DatabaseIncidentSnapshot[]
  };
}

export function saveDatabaseIncidentSnapshot(snapshot: DatabaseIncidentSnapshot): Promise<DatabaseIncidentHistoryResult> {
  return enqueue(async () => {
    const parsed = snapshotV2Schema.parse(snapshot) as DatabaseIncidentSnapshot;
    const persisted: DatabaseIncidentSnapshot = {
      ...parsed,
      savedAt: parsed.savedAt ?? new Date().toISOString()
    };
    const connectionKey = key(persisted.connection);
    const file = await readFile();
    const others = file.snapshots.filter(item => item.connection.toLowerCase() !== connectionKey);
    const current = file.snapshots
      .filter(item => item.connection.toLowerCase() === connectionKey && item.id !== persisted.id)
      .map(item => item as DatabaseIncidentSnapshot);
    const snapshots = [persisted, ...current]
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, MAX_INCIDENTS_PER_CONNECTION);
    await writeFile({ version: 2, snapshots: [...others, ...snapshots] });
    return { connection: persisted.connection, snapshots };
  });
}

export function deleteDatabaseIncidentSnapshot(connection: string, snapshotId: string): Promise<DatabaseIncidentHistoryResult> {
  return enqueue(async () => {
    const connectionKey = key(connection);
    const id = z.string().uuid().parse(snapshotId);
    const file = await readFile();
    const snapshots = file.snapshots.filter(snapshot => snapshot.connection.toLowerCase() !== connectionKey || snapshot.id !== id);
    if (snapshots.length === file.snapshots.length) throw new Error(`Database incident snapshot ${id} was not found.`);
    await writeFile({ version: 2, snapshots });
    return {
      connection,
      snapshots: snapshots
        .filter(snapshot => snapshot.connection.toLowerCase() === connectionKey)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)) as DatabaseIncidentSnapshot[]
    };
  });
}

export function clearDatabaseIncidentHistory(connection: string): Promise<DatabaseIncidentHistoryResult> {
  return enqueue(async () => {
    const connectionKey = key(connection);
    const file = await readFile();
    const snapshots = file.snapshots.filter(snapshot => snapshot.connection.toLowerCase() !== connectionKey);
    if (snapshots.length !== file.snapshots.length) await writeFile({ version: 2, snapshots });
    return { connection, snapshots: [] };
  });
}

export function resetDatabaseIncidentHistoryForTests(): void {
  historyPath = '';
  mutationQueue = Promise.resolve();
}
