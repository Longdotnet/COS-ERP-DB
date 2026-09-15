import { describe, expect, it } from 'vitest';
import { configuredDatabaseShellPolicyViolation } from '../src/main/database/exec-policy.js';
import type { DatabaseSettings } from '../src/shared/database.js';

const settings: DatabaseSettings = {
  defaultConnectionId: 'asuz',
  connections: [
    {
      id: 'asuz',
      name: 'ASUZ',
      provider: 'sqlserver',
      accessMode: 'read-only',
      server: 'ASUZ',
      database: 'L70CAFE_HOATAN',
      encrypt: true,
      trustServerCertificate: true,
      authentication: { type: 'sql', user: 'longvtt' }
    },
    {
      id: 'write-lab',
      name: 'Write Lab',
      provider: 'sqlserver',
      accessMode: 'full-access',
      server: 'LABSQL',
      database: 'ERP_LAB',
      encrypt: true,
      trustServerCertificate: true,
      authentication: { type: 'sql', user: 'dev' }
    }
  ]
};

const readSettings = async () => settings;

describe('configured database shell policy', () => {
  it('blocks sqlcmd from bypassing a read-only configured profile', async () => {
    const result = await configuredDatabaseShellPolicyViolation([
      'sqlcmd -S ASUZ -d L70CAFE_HOATAN -E -Q "UPDATE dbo.L00ZONES SET Description = N\'A\'"'
    ], readSettings);

    expect(result).toMatch(/DATABASE_SHELL_BYPASS_BLOCKED/);
    expect(result).toContain('"asuz"');
    expect(result).toContain('read-only');
  });

  it('also blocks direct shell access to a full-access profile so writes stay owned by the database feature', async () => {
    const result = await configuredDatabaseShellPolicyViolation([
      'Invoke-Sqlcmd -ServerInstance LABSQL -Database ERP_LAB -Query "SELECT 1"'
    ], readSettings);

    expect(result).toMatch(/DATABASE_SHELL_BYPASS_BLOCKED/);
    expect(result).toContain('full-access');
  });

  it('blocks driver scripts that target a configured profile', async () => {
    const result = await configuredDatabaseShellPolicyViolation([
      'python -c "import pyodbc; pyodbc.connect(\'Server=ASUZ;Database=L70CAFE_HOATAN\')"'
    ], readSettings);

    expect(result).toMatch(/DATABASE_SHELL_BYPASS_BLOCKED/);
  });

  it('allows SQL clients aimed at a target the app does not own', async () => {
    await expect(configuredDatabaseShellPolicyViolation([
      'sqlcmd -S OTHERHOST -d OTHER_DB -E -Q "SELECT 1"'
    ], readSettings)).resolves.toBeNull();
  });

  it('does not interfere with ordinary shell work that merely mentions a configured database', async () => {
    await expect(configuredDatabaseShellPolicyViolation([
      'rg -n "L70CAFE_HOATAN" src test'
    ], readSettings)).resolves.toBeNull();
  });

  it('does not mistake SQL examples in search, logs or source text for database access', async () => {
    await expect(configuredDatabaseShellPolicyViolation([
      'rg -n "sqlcmd -S ASUZ -d L70CAFE_HOATAN" src test',
      'Write-Output "import pyodbc; Server=ASUZ;Database=L70CAFE_HOATAN"',
      'git grep "Invoke-Sqlcmd -ServerInstance ASUZ"'
    ], readSettings)).resolves.toBeNull();
  });

  it('still blocks a SQL client launched after an unrelated shell command', async () => {
    const result = await configuredDatabaseShellPolicyViolation([
      'Write-Host "checking"; sqlcmd -S ASUZ -d L70CAFE_HOATAN -E -Q "SELECT 1"'
    ], readSettings);

    expect(result).toMatch(/DATABASE_SHELL_BYPASS_BLOCKED/);
  });

  it('fails closed when direct SQL shell access is attempted before profile policy can be read', async () => {
    const result = await configuredDatabaseShellPolicyViolation(
      ['sqlcmd -S ASUZ -d L70CAFE_HOATAN -E -Q "SELECT 1"'],
      async () => { throw new Error('store unavailable'); }
    );

    expect(result).toMatch(/DATABASE_PROFILE_STATE_UNAVAILABLE/);
  });
});
