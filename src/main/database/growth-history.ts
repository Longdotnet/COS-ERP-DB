import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  DatabaseGrowthHistoryResult,
  DatabaseGrowthSnapshot,
  DatabaseGrowthSnapshotInput
} from '../../shared/database.js';

const FILE_NAME = 'database-growth-history.json';
const MAX_SNAPSHOTS_PER_CONNECTION = 52;
let historyPath = '';
let mutationQueue: Promise<void> = Promise.resolve();

const summarySchema = z.object({
  totalMb: z.number().finite().nonnegative(),
  dataMb: z.number().finite().nonnegative(),
  logMb: z.number().finite().nonnegative(),
  dataUsedMb: z.number().finite().nonnegative(),
  logUsedMb: z.number().finite().nonnegative(),
  logUsedPercent: z.number().finite().nonnegative(),
  tableCount: z.number().finite().nonnegative()
}).strict();

const tableSchema = z.object({
  objectId: z.number().int().positive(),
  schema: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  rows: z.number().finite().nonnegative(),
  reservedMb: z.number().finite().nonnegative(),
  usedMb: z.number().finite().nonnegative(),
  dataMb: z.number().finite().nonnegative(),
  indexMb: z.number().finite().nonnegative()
}).strict();

const fileSchema = z.object({
  name: z.string().min(1).max(256),
  type: z.enum(['data', 'log']),
  sizeMb: z.number().finite().nonnegative(),
  usedMb: z.number().finite().nonnegative().nullable(),
  freeMb: z.number().finite().nonnegative().nullable(),
  growth: z.number().finite().nonnegative(),
  percentGrowth: z.boolean()
}).strict();

const tableFingerprintSchema = z.object({
  schema: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  columnCount: z.number().int().nonnegative(),
  indexCount: z.number().int().nonnegative(),
  columnHash: z.string().min(1).max(64),
  indexHash: z.string().min(1).max(64)
}).strict();

export const databaseGrowthSnapshotInputSchema = z.object({
  captureVersion: z.literal(2).optional(),
  database: z.string().max(256),
  capturedAt: z.string().datetime(),
  summary: summarySchema,
  largestTables: z.array(tableSchema).max(25).optional(),
  files: z.array(fileSchema).max(64).optional(),
  tables: z.array(tableSchema).max(5000).optional(),
  tablesTruncated: z.boolean().optional(),
  tableFingerprints: z.array(tableFingerprintSchema).max(5000).optional(),
  schemaTruncated: z.boolean().optional(),
  limitations: z.array(z.string().max(1000)).max(32).optional()
}).strict();

const snapshotSchema = databaseGrowthSnapshotInputSchema.extend({
  id: z.string().uuid(),
  connection: z.string().min(1).max(64),
  savedAt: z.string().datetime()
}).strict();

const historySchema = z.object({
  version: z.literal(1),
  snapshots: z.array(snapshotSchema).max(32 * MAX_SNAPSHOTS_PER_CONNECTION)
}).strict();

type HistoryFile = z.infer<typeof historySchema>;

function assertInitialized(): string {
  if (!historyPath) throw new Error('Database growth history store is not initialized');
  return historyPath;
}

export function initDatabaseGrowthHistory(userDataDir: string): void {
  historyPath = path.join(userDataDir, FILE_NAME);
}

async function readFile(): Promise<HistoryFile> {
  const file = assertInitialized();
  try {
    return historySchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, snapshots: [] };
    throw new Error(`Database growth history could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeFile(value: HistoryFile): Promise<void> {
  const file = assertInitialized();
  const parsed = historySchema.parse(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function connectionKey(connection: string): string {
  const value = connection.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error('Invalid database connection id');
  return value.toLowerCase();
}

export async function readDatabaseGrowthHistory(connection: string): Promise<DatabaseGrowthHistoryResult> {
  const key = connectionKey(connection);
  const file = await readFile();
  return {
    connection,
    snapshots: file.snapshots
      .filter(snapshot => snapshot.connection.toLowerCase() === key)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
  };
}

export async function readDatabaseGrowthSnapshot(connection: string, snapshotId: string): Promise<DatabaseGrowthSnapshot> {
  const history = await readDatabaseGrowthHistory(connection);
  const snapshot = history.snapshots.find(candidate => candidate.id === snapshotId);
  if (!snapshot) throw new Error(`Database growth snapshot ${snapshotId} was not found for connection ${connection}.`);
  return snapshot;
}

export function saveDatabaseGrowthSnapshot(connection: string, input: DatabaseGrowthSnapshotInput): Promise<DatabaseGrowthHistoryResult> {
  return enqueue(async () => {
    const key = connectionKey(connection);
    const parsed = databaseGrowthSnapshotInputSchema.parse(input);
    const file = await readFile();
    const others = file.snapshots.filter(snapshot => snapshot.connection.toLowerCase() !== key);
    const existing = file.snapshots.filter(snapshot => snapshot.connection.toLowerCase() === key);
    const duplicate = existing.find(snapshot => snapshot.capturedAt === parsed.capturedAt);
    const snapshot: DatabaseGrowthSnapshot = duplicate ?? {
      id: randomUUID(),
      connection,
      savedAt: new Date().toISOString(),
      ...parsed
    };
    const snapshots = duplicate
      ? existing
      : [snapshot, ...existing]
          .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
          .slice(0, MAX_SNAPSHOTS_PER_CONNECTION);
    await writeFile({ version: 1, snapshots: [...others, ...snapshots] });
    return {
      connection,
      snapshots: snapshots.slice().sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
    };
  });
}

export function deleteDatabaseGrowthSnapshot(connection: string, snapshotId: string): Promise<DatabaseGrowthHistoryResult> {
  return enqueue(async () => {
    const key = connectionKey(connection);
    const id = z.string().uuid().parse(snapshotId);
    const file = await readFile();
    const snapshots = file.snapshots.filter(snapshot =>
      snapshot.connection.toLowerCase() !== key || snapshot.id !== id
    );
    if (snapshots.length === file.snapshots.length) {
      throw new Error(`Database growth snapshot ${id} was not found for connection ${connection}.`);
    }
    await writeFile({ version: 1, snapshots });
    return {
      connection,
      snapshots: snapshots
        .filter(snapshot => snapshot.connection.toLowerCase() === key)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
    };
  });
}

export function clearDatabaseGrowthHistory(connection: string): Promise<DatabaseGrowthHistoryResult> {
  return enqueue(async () => {
    const key = connectionKey(connection);
    const file = await readFile();
    const snapshots = file.snapshots.filter(snapshot => snapshot.connection.toLowerCase() !== key);
    if (snapshots.length !== file.snapshots.length) await writeFile({ version: 1, snapshots });
    return { connection, snapshots: [] };
  });
}

export function resetDatabaseGrowthHistoryForTests(): void {
  historyPath = '';
  mutationQueue = Promise.resolve();
}
