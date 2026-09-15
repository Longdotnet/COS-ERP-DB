import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseConnectionProfile, DatabaseSettings } from '../../shared/database.js';

const FILE_NAME = 'database-profiles.json';
const EMPTY_SETTINGS: DatabaseSettings = { connections: [] };
let settingsPath = '';
let mutationQueue: Promise<void> = Promise.resolve();

const authentication = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sql'), user: z.string().trim().min(1).max(256) }).strict(),
  z.object({ type: z.literal('ntlm'), user: z.string().trim().min(1).max(256), domain: z.string().trim().min(1).max(256) }).strict()
]);

const accessMode = z.enum(['read-only', 'full-access']);

const profileObjectSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  name: z.string().trim().min(1).max(120),
  provider: z.literal('sqlserver'),
  // Existing COS-ERP-DB profiles predate access modes. Missing persisted values migrate
  // conservatively to read-only at the single profile-store boundary.
  accessMode: accessMode.default('read-only'),
  server: z.string().trim().min(1).max(512),
  database: z.string().trim().min(1).max(256),
  port: z.number().int().min(1).max(65_535).optional(),
  instanceName: z.string().trim().min(1).max(128).optional(),
  encrypt: z.boolean(),
  trustServerCertificate: z.boolean(),
  authentication
}).strict();

const profileSchema = profileObjectSchema.refine(
  profile => !(profile.port !== undefined && profile.instanceName),
  'port and instanceName cannot both be set'
);

const settingsSchema = z.object({
  connections: z.array(profileSchema).max(32).refine(
    rows => new Set(rows.map(row => row.id.toLowerCase())).size === rows.length,
    'Duplicate database connection id'
  ),
  defaultConnectionId: z.string().min(1).max(64).optional()
}).strict().superRefine((settings, ctx) => {
  if (settings.defaultConnectionId && !settings.connections.some(row => row.id.toLowerCase() === settings.defaultConnectionId!.toLowerCase())) {
    ctx.addIssue({ code: 'custom', path: ['defaultConnectionId'], message: 'Default database connection must refer to a configured connection id' });
  }
});

const draftSchema = profileObjectSchema.omit({ id: true, provider: true }).extend({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
  // Omission means "preserve the existing mode" for legacy callers and read-only for new profiles.
  accessMode: accessMode.optional(),
  makeDefault: z.boolean().optional()
}).strict().refine(profile => !(profile.port !== undefined && profile.instanceName), 'port and instanceName cannot both be set');

function assertInitialized(): string {
  if (!settingsPath) throw new Error('Database profile store is not initialized');
  return settingsPath;
}

export function initDatabaseStore(userDataDir: string): void {
  settingsPath = path.join(userDataDir, FILE_NAME);
}

async function readSettingsFromDisk(): Promise<DatabaseSettings> {
  const file = assertInitialized();
  try {
    return settingsSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_SETTINGS, connections: [] };
    throw new Error(`Database profile store could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeSettings(settings: DatabaseSettings): Promise<void> {
  const file = assertInitialized();
  const parsed = settingsSchema.parse(settings);
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

export function readDatabaseSettings(): Promise<DatabaseSettings> {
  return readSettingsFromDisk();
}

function newProfileId(name: string, existing: readonly DatabaseConnectionProfile[]): string {
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const base = normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 48) || 'sqlserver';
  const occupied = new Set(existing.map(profile => profile.id.toLowerCase()));
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, Math.max(1, 60 - String(suffix).length))}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `db-${randomUUID().slice(0, 8)}`;
}

export function saveDatabaseProfile(input: unknown): Promise<{ settings: DatabaseSettings; profileId: string }> {
  return enqueue(async () => {
    const draft = draftSchema.parse(input);
    const current = await readSettingsFromDisk();
    const existingIndex = draft.id
      ? current.connections.findIndex(profile => profile.id.toLowerCase() === draft.id!.toLowerCase())
      : -1;
    if (draft.id && existingIndex < 0) throw new Error('Database connection not found');
    if (current.connections.some((profile, index) => index !== existingIndex && profile.name.toLowerCase() === draft.name.toLowerCase())) {
      throw new Error('Database connection name is already in use');
    }
    const profileId = draft.id ?? newProfileId(draft.name, current.connections);
    const existing = existingIndex >= 0 ? current.connections[existingIndex] : undefined;
    const profile: DatabaseConnectionProfile = {
      id: profileId,
      name: draft.name,
      provider: 'sqlserver',
      accessMode: draft.accessMode ?? existing?.accessMode ?? 'read-only',
      server: draft.server,
      database: draft.database,
      ...(draft.port === undefined ? {} : { port: draft.port }),
      ...(draft.instanceName ? { instanceName: draft.instanceName } : {}),
      encrypt: draft.encrypt,
      trustServerCertificate: draft.trustServerCertificate,
      authentication: draft.authentication
    };
    const connections = [...current.connections];
    if (existingIndex >= 0) connections[existingIndex] = profile;
    else connections.push(profile);
    const settings: DatabaseSettings = {
      connections,
      defaultConnectionId: draft.makeDefault || !current.defaultConnectionId ? profileId : current.defaultConnectionId
    };
    await writeSettings(settings);
    return { settings, profileId };
  });
}

export function removeDatabaseProfile(id: string): Promise<DatabaseSettings> {
  return enqueue(async () => {
    const current = await readSettingsFromDisk();
    if (!current.connections.some(profile => profile.id === id)) throw new Error('Database connection not found');
    const connections = current.connections.filter(profile => profile.id !== id);
    const settings: DatabaseSettings = {
      connections,
      ...(current.defaultConnectionId === id
        ? (connections[0] ? { defaultConnectionId: connections[0].id } : {})
        : current.defaultConnectionId ? { defaultConnectionId: current.defaultConnectionId } : {})
    };
    await writeSettings(settings);
    return settings;
  });
}

export function resetDatabaseStoreForTests(): void {
  settingsPath = '';
  mutationQueue = Promise.resolve();
}
