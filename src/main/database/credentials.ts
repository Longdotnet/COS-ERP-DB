import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeStorage } from 'electron';
import { isEncryptionAvailable, secureStorageCiphertextIsProtected } from '../secrets.js';
import type { DatabaseConnectionProfile } from '../../shared/database.js';

const FILE_NAME = 'database-secrets.bin';
let credentialsPath = '';
let mutationQueue: Promise<void> = Promise.resolve();

interface BoundDatabaseCredential {
  password: string;
  binding: string;
}

type StoredDatabaseCredential = string | BoundDatabaseCredential;
type StoredDatabaseCredentials = Record<string, StoredDatabaseCredential>;

function slot(profileId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profileId)) throw new Error('Invalid database connection id');
  return profileId.toLowerCase();
}

export function initDatabaseCredentials(userDataDir: string): void {
  credentialsPath = path.join(userDataDir, FILE_NAME);
}

/**
 * Passwords are bound to the endpoint/login identity that is allowed to receive them. Database,
 * display name, TLS policy and access mode deliberately do not participate: changing those does
 * not change which SQL Server principal receives the password.
 */
export function databaseCredentialBinding(profile: DatabaseConnectionProfile): string {
  const authentication = profile.authentication.type === 'sql'
    ? { type: 'sql', user: profile.authentication.user.trim().toLowerCase() }
    : {
        type: 'ntlm',
        user: profile.authentication.user.trim().toLowerCase(),
        domain: profile.authentication.domain.trim().toLowerCase()
      };
  const identity = {
    server: profile.server.trim().toLowerCase(),
    port: profile.port ?? null,
    instanceName: profile.instanceName?.trim().toLowerCase() ?? null,
    authentication
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function assertInitialized(): string {
  if (!credentialsPath) throw new Error('Database credential store is not initialized');
  return credentialsPath;
}

function isBoundCredential(value: unknown): value is BoundDatabaseCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => key === 'password' || key === 'binding') &&
    typeof record.password === 'string' && typeof record.binding === 'string' && /^[a-f0-9]{64}$/.test(record.binding);
}

async function readAll(): Promise<StoredDatabaseCredentials> {
  if (!(await isEncryptionAvailable())) return {};
  const file = assertInitialized();
  try {
    const blob = await fs.readFile(file);
    if (!secureStorageCiphertextIsProtected(blob)) throw new Error('Database credential store is not protected by secure OS storage');
    const decrypted = await safeStorage.decryptStringAsync(blob);
    const parsed: unknown = JSON.parse(decrypted.result);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Database credential payload is invalid');
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      // String values are the V0 on-disk format. They are accepted only so the next resolver or
      // profile edit can bind them to the current endpoint before metadata is allowed to change.
      if (typeof value !== 'string' && !isBoundCredential(value)) throw new Error('Database credential payload is invalid');
    }
    return parsed as StoredDatabaseCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeAll(values: StoredDatabaseCredentials): Promise<void> {
  if (!(await isEncryptionAvailable())) throw new Error('Secure OS credential storage is unavailable, so the database password was not saved');
  const file = assertInitialized();
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(values));
  if (!secureStorageCiphertextIsProtected(encrypted)) throw new Error('Secure OS credential storage is unavailable, so the database password was not saved');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, encrypted);
  await fs.rename(temp, file);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function bindLegacyDatabaseCredential(profile: DatabaseConnectionProfile): Promise<void> {
  return enqueue(async () => {
    const key = slot(profile.id);
    const current = await readAll();
    const value = current[key];
    if (typeof value !== 'string') return;
    if (value === '') delete current[key];
    else current[key] = { password: value, binding: databaseCredentialBinding(profile) };
    await writeAll(current);
  });
}

export async function getDatabasePassword(profile: DatabaseConnectionProfile): Promise<string | null> {
  const key = slot(profile.id);
  let value = (await readAll())[key];
  if (typeof value === 'string') {
    await bindLegacyDatabaseCredential(profile);
    value = (await readAll())[key];
  }
  if (!value || typeof value === 'string' || value.password === '') return null;
  return value.binding === databaseCredentialBinding(profile) ? value.password : null;
}

export async function hasDatabasePassword(profile: DatabaseConnectionProfile): Promise<boolean> {
  return (await getDatabasePassword(profile)) !== null;
}

export async function databasePasswordPresence(profiles: readonly DatabaseConnectionProfile[]): Promise<Record<string, boolean>> {
  const all = await readAll();
  return Object.fromEntries(profiles.map(profile => {
    const value = all[slot(profile.id)];
    const present = typeof value === 'string'
      ? value.length > 0
      : Boolean(value?.password) && value!.binding === databaseCredentialBinding(profile);
    return [profile.id, present];
  }));
}

/** SQL Server passwords are opaque values; leading/trailing spaces are significant. */
export function setDatabasePassword(profile: DatabaseConnectionProfile, password: string): Promise<void> {
  return enqueue(async () => {
    const key = slot(profile.id);
    const current = await readAll();
    if (password === '') delete current[key];
    else current[key] = { password, binding: databaseCredentialBinding(profile) };
    await writeAll(current);
  });
}

export function clearDatabasePassword(profileId: string): Promise<void> {
  return enqueue(async () => {
    const key = slot(profileId);
    const current = await readAll();
    if (current[key] === undefined) return;
    delete current[key];
    await writeAll(current);
  });
}

export function resetDatabaseCredentialsForTests(): void {
  credentialsPath = '';
  mutationQueue = Promise.resolve();
}
