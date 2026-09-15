import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnectionProfile } from '../src/shared/database.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const { safeStorage } = await import('electron');
const {
  bindLegacyDatabaseCredential,
  clearDatabasePassword,
  databaseCredentialBinding,
  databasePasswordPresence,
  getDatabasePassword,
  initDatabaseCredentials,
  resetDatabaseCredentialsForTests,
  setDatabasePassword
} = await import('../src/main/database/credentials.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

function profile(overrides: Partial<DatabaseConnectionProfile> = {}): DatabaseConnectionProfile {
  return {
    id: 'linkq-test',
    name: 'LinkQ Test',
    provider: 'sqlserver',
    accessMode: 'read-only',
    server: 'linkqwin.linkq.vn',
    database: 'L80LINKQ.TEST',
    port: 2027,
    encrypt: true,
    trustServerCertificate: false,
    authentication: { type: 'sql', user: 'long' },
    ...overrides
  };
}

beforeEach(async () => {
  dir = await makeTempDir('cos-erp-db-credentials-');
  initDatabaseCredentials(dir);
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret');
  vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async value => Buffer.from(value, 'utf8'));
  vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async buffer => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }));
});

afterEach(async () => {
  resetDatabaseCredentialsForTests();
  await removeTempDir(dir);
});

describe('database credential store', () => {
  it('preserves exact SQL Server password bytes and keeps them out of profile metadata', async () => {
    const password = '  database password with spaces  ';
    const connection = profile();
    await setDatabasePassword(connection, password);
    expect(await getDatabasePassword(connection)).toBe(password);

    const encryptedFile = await fs.readFile(path.join(dir, 'database-secrets.bin'));
    expect(encryptedFile.length).toBeGreaterThan(0);
    await clearDatabasePassword('linkq-test');
    expect(await getDatabasePassword(connection)).toBeNull();
  });

  it('never returns a password to a changed server or login identity', async () => {
    const original = profile();
    await setDatabasePassword(original, 'secret');

    expect(await getDatabasePassword(profile({ database: 'OTHER', encrypt: false, trustServerCertificate: true }))).toBe('secret');
    expect(await getDatabasePassword(profile({ server: 'other-server' }))).toBeNull();
    expect(await getDatabasePassword(profile({ authentication: { type: 'sql', user: 'another-user' } }))).toBeNull();
    expect(await databasePasswordPresence([profile({ server: 'other-server' })])).toEqual({ 'linkq-test': false });
  });

  it('binds the legacy string format before endpoint metadata can change', async () => {
    const legacy = JSON.stringify({ 'linkq-test': 'legacy-secret' });
    await fs.writeFile(path.join(dir, 'database-secrets.bin'), Buffer.from(legacy, 'utf8'));
    const original = profile();

    await bindLegacyDatabaseCredential(original);
    expect(await getDatabasePassword(original)).toBe('legacy-secret');
    expect(await getDatabasePassword(profile({ server: 'moved-server' }))).toBeNull();

    const stored = JSON.parse((await fs.readFile(path.join(dir, 'database-secrets.bin'))).toString('utf8'));
    expect(stored['linkq-test']).toMatchObject({
      password: 'legacy-secret',
      binding: databaseCredentialBinding(original)
    });
  });
});
