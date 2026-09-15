import type { DatabaseAccessMode, DatabaseConnectionProfile } from '../../shared/database.js';
import { getDatabasePassword } from './credentials.js';
import { readDatabaseSettings } from './store.js';
import type { SqlServerConnection } from './sqlserver.js';

export interface ResolvedSqlServerProfile {
  id: string;
  name: string;
  accessMode: DatabaseAccessMode;
  connection: SqlServerConnection;
}

function chooseProfile(settings: Awaited<ReturnType<typeof readDatabaseSettings>>, requested: string | undefined): DatabaseConnectionProfile {
  const wanted = requested?.trim() || settings.defaultConnectionId?.trim();
  if (wanted) {
    const found = settings.connections.find(profile => profile.id.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new Error(`DATABASE_CONNECTION_NOT_FOUND: no configured database connection named "${wanted}"`);
    return found;
  }
  if (settings.connections.length === 1) return settings.connections[0]!;
  if (settings.connections.length === 0) {
    throw new Error('DATABASE_NOT_CONFIGURED: add a SQL Server connection in COS-ERP-DB first');
  }
  throw new Error('DATABASE_CONNECTION_REQUIRED: choose one configured database connection');
}

/** Resolve model-visible profile identity to main-process-only credentials. */
export async function resolveSqlServerProfile(requested?: string): Promise<ResolvedSqlServerProfile> {
  const profile = chooseProfile(await readDatabaseSettings(), requested);
  const password = await getDatabasePassword(profile);
  if (password === null) {
    throw new Error(`DATABASE_CREDENTIAL_MISSING: connection "${profile.id}" has no stored password`);
  }
  return {
    id: profile.id,
    name: profile.name,
    accessMode: profile.accessMode,
    connection: {
      server: profile.server,
      database: profile.database,
      ...(profile.port === undefined ? {} : { port: profile.port }),
      ...(profile.instanceName ? { instanceName: profile.instanceName } : {}),
      encrypt: profile.encrypt,
      trustServerCertificate: profile.trustServerCertificate,
      authentication: profile.authentication.type === 'sql'
        ? { type: 'sql', user: profile.authentication.user, password }
        : {
            type: 'ntlm',
            user: profile.authentication.user,
            domain: profile.authentication.domain,
            password
          }
    }
  };
}
