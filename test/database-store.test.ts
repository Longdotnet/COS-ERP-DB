import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initDatabaseStore,
  readDatabaseSettings,
  removeDatabaseProfile,
  resetDatabaseStoreForTests,
  saveDatabaseProfile
} from '../src/main/database/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('cos-erp-db-profiles-');
  initDatabaseStore(dir);
});

afterEach(async () => {
  resetDatabaseStoreForTests();
  await removeTempDir(dir);
});

describe('database profile store', () => {
  it('owns metadata outside upstream config and repairs the default when a profile is removed', async () => {
    const saved = await saveDatabaseProfile({
      name: 'LinkQ Test',
      server: 'linkqwin.linkq.vn',
      database: 'L80LINKQ.TEST',
      port: 2027,
      encrypt: false,
      trustServerCertificate: true,
      authentication: { type: 'sql', user: 'long' },
      makeDefault: true
    });
    expect(saved.profileId).toBe('linkq-test');
    expect(await readDatabaseSettings()).toMatchObject({
      defaultConnectionId: 'linkq-test',
      connections: [{
        id: 'linkq-test', provider: 'sqlserver', accessMode: 'read-only',
        server: 'linkqwin.linkq.vn', database: 'L80LINKQ.TEST'
      }]
    });
    const text = await fs.readFile(path.join(dir, 'database-profiles.json'), 'utf8');
    expect(text).toContain('linkqwin.linkq.vn');
    expect(text).not.toMatch(/password/i);

    expect(await removeDatabaseProfile('linkq-test')).toEqual({ connections: [] });
  });

  it('rejects port plus instance and duplicate display names', async () => {
    await expect(saveDatabaseProfile({
      name: 'Invalid', server: 'localhost', database: 'db', port: 1433, instanceName: 'SQLEXPRESS',
      encrypt: false, trustServerCertificate: true, authentication: { type: 'sql', user: 'sa' }
    })).rejects.toThrow(/port and instanceName|either port/i);

    await saveDatabaseProfile({
      name: 'One', server: 'localhost', database: 'db', encrypt: false, trustServerCertificate: true,
      authentication: { type: 'sql', user: 'sa' }
    });
    await expect(saveDatabaseProfile({
      name: 'One', server: 'other', database: 'db2', encrypt: false, trustServerCertificate: true,
      authentication: { type: 'sql', user: 'sa' }
    })).rejects.toThrow(/name is already in use/i);
  });

  it('migrates legacy profiles to read-only and preserves an existing mode when an old UI edits metadata', async () => {
    await fs.writeFile(path.join(dir, 'database-profiles.json'), JSON.stringify({
      connections: [{
        id: 'legacy', name: 'Legacy', provider: 'sqlserver', server: 'localhost', database: 'ERP',
        encrypt: false, trustServerCertificate: true, authentication: { type: 'sql', user: 'reader' }
      }],
      defaultConnectionId: 'legacy'
    }), 'utf8');

    expect((await readDatabaseSettings()).connections[0]?.accessMode).toBe('read-only');

    await saveDatabaseProfile({
      id: 'legacy', name: 'Legacy', server: 'localhost', database: 'ERP', accessMode: 'full-access',
      encrypt: false, trustServerCertificate: true, authentication: { type: 'sql', user: 'reader' }
    });
    await saveDatabaseProfile({
      id: 'legacy', name: 'Legacy renamed', server: 'localhost', database: 'ERP',
      encrypt: false, trustServerCertificate: true, authentication: { type: 'sql', user: 'reader' }
    });

    expect((await readDatabaseSettings()).connections[0]).toMatchObject({ name: 'Legacy renamed', accessMode: 'full-access' });
  });
});
