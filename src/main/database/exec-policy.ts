import type { DatabaseConnectionProfile, DatabaseSettings } from '../../shared/database.js';
import { readDatabaseSettings } from './store.js';

const DIRECT_SQL_COMMAND =
  /(?:^|[;&|]\s*)(?:&\s*)?(?:(?:"[^"]*[\\/])|(?:'[^']*[\\/])|(?:[^\s;&|]*[\\/]))?(?:sqlcmd(?:\.exe)?|invoke-sqlcmd|osql(?:\.exe)?|bcp(?:\.exe)?|sqlpackage(?:\.exe)?)(?=[\s'";&|]|$)/i;

const SCRIPT_RUNTIME = /(?:^|[;&|]\s*)(?:python(?:\.exe)?|py(?:\.exe)?|node(?:\.exe)?|deno(?:\.exe)?|bun(?:\.exe)?)(?=\s)/i;
const SCRIPT_SQL_DRIVER = [
  /\bpyodbc\b/i,
  /\bpymssql\b/i,
  /\btedious\b/i,
  /\brequire\s*\(\s*['"]mssql['"]\s*\)/i,
  /\bfrom\s+['"]mssql['"]/i
] as const;

const POWERSHELL_SQLCLIENT_EXECUTION = [
  /\bnew-object\s+(?:system|microsoft)\.data\.sqlclient\.sqlconnection\b/i,
  /\[(?:system|microsoft)\.data\.sqlclient\.sqlconnection\]\s*::\s*(?:new|new\s*\()/i
] as const;

function isSqlShellAccess(command: string): boolean {
  if (DIRECT_SQL_COMMAND.test(command)) return true;
  if (SCRIPT_RUNTIME.test(command) && SCRIPT_SQL_DRIVER.some(pattern => pattern.test(command))) return true;
  return POWERSHELL_SQLCLIENT_EXECUTION.some(pattern => pattern.test(command));
}

function profileNeedles(profile: DatabaseConnectionProfile): string[] {
  return [
    profile.id,
    profile.name,
    profile.server,
    profile.database,
    ...(profile.port === undefined ? [] : [`${profile.server},${profile.port}`]),
    ...(profile.instanceName ? [`${profile.server}\\${profile.instanceName}`] : [])
  ]
    .map(value => value.trim().toLowerCase())
    .filter(value => value.length >= 2);
}

function targetedProfile(command: string, settings: DatabaseSettings): DatabaseConnectionProfile | null {
  const normalized = command.toLowerCase();
  return settings.connections.find(profile => profileNeedles(profile).some(needle => normalized.includes(needle))) ?? null;
}

/**
 * A configured database profile owns agent access to that SQL Server target.
 *
 * `exec_command` is a real host shell. Without this fence, an agent can bypass a profile's
 * access mode with sqlcmd, Invoke-Sqlcmd, SqlClient or a short driver script even though the
 * database tool itself correctly refuses the operation. This is deliberately a narrow policy
 * fence around configured targets; unrelated shell/database work is left alone.
 */
export async function configuredDatabaseShellPolicyViolation(
  commands: readonly string[],
  readSettings: () => Promise<DatabaseSettings> = readDatabaseSettings
): Promise<string | null> {
  const candidates = commands.filter(isSqlShellAccess);
  if (candidates.length === 0) return null;

  let settings: DatabaseSettings;
  try {
    settings = await readSettings();
  } catch (error) {
    return 'DATABASE_PROFILE_STATE_UNAVAILABLE: a command attempted direct SQL Server shell/driver access, but configured database policy could not be read. No command was run.';
  }

  for (const command of candidates) {
    const profile = targetedProfile(command, settings);
    if (!profile) continue;
    return (
      `DATABASE_SHELL_BYPASS_BLOCKED: configured SQL Server connection "${profile.id}" (${profile.database}) ` +
      `must be accessed through the database tool so its ${profile.accessMode} access mode is enforced. ` +
      'Direct sqlcmd/PowerShell/driver access through exec_command is blocked. No command was run.'
    );
  }
  return null;
}
