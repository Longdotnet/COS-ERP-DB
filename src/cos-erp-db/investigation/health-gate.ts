import type { SqlServerConnection } from '../../main/database/sqlserver.js';
import { readSqlServerGrowthDiagnostics } from '../../main/database/growth-diagnostics.js';
import {
  readSqlServerDeadlocks,
  readSqlServerDiagnosticHistory,
  readSqlServerJobs,
  readSqlServerLivePerformance,
  readSqlServerQueryStore
} from './sqlserver-investigator.js';
import type { DatabaseHealthCheck, DatabaseHealthGateResult } from './types.js';

function settledError(result: PromiseSettledResult<unknown>): string {
  if (result.status !== 'rejected') return '';
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function overallStatus(checks: readonly DatabaseHealthCheck[]): DatabaseHealthGateResult['status'] {
  if (checks.some(check => check.status === 'critical')) return 'critical';
  if (checks.some(check => check.status === 'attention' || check.status === 'unavailable')) return 'attention';
  return 'healthy';
}

export async function readDatabaseHealthGate(
  connectionId: string,
  connection: SqlServerConnection
): Promise<DatabaseHealthGateResult> {
  const startedAt = Date.now();
  const capturedAt = new Date().toISOString();
  const [queryStore, live, deadlocks, jobs, growth, serverHistory] = await Promise.allSettled([
    readSqlServerQueryStore(connectionId, connection, { hours: 1, sort: 'reads' }),
    readSqlServerLivePerformance(connectionId, connection),
    readSqlServerDeadlocks(connectionId, connection),
    readSqlServerJobs(connectionId, connection),
    readSqlServerGrowthDiagnostics(connection),
    readSqlServerDiagnosticHistory(connectionId, connection)
  ]);
  const checks: DatabaseHealthCheck[] = [];
  const limitations: string[] = [];

  if (queryStore.status === 'fulfilled') {
    const value = queryStore.value;
    const healthy = value.available && value.actualState === 'READ_WRITE';
    const storage = value.currentStorageMb !== null && value.maxStorageMb !== null
      ? 'storage=' + value.currentStorageMb.toFixed(1) + '/' + value.maxStorageMb.toFixed(1) + ' MB'
      : null;
    checks.push({
      id: 'query-store',
      status: healthy ? 'ok' : 'attention',
      summary: healthy ? 'Query Store is capturing history.' : 'Query Store historical capture needs attention.',
      detail: [
        'actual=' + (value.actualState ?? 'unknown'),
        'desired=' + (value.desiredState ?? 'unknown'),
        'readonlyReason=' + (value.readonlyReason ?? 'n/a'),
        storage
      ].filter(Boolean).join(', ')
    });
    limitations.push(...value.limitations);
  } else {
    checks.push({
      id: 'query-store',
      status: 'unavailable',
      summary: 'Query Store health could not be read.',
      detail: settledError(queryStore)
    });
    limitations.push('Query Store health could not be captured.');
  }

  if (live.status === 'fulfilled') {
    const value = live.value;
    const incidentCount = value.incidentSessions.filter(session => session.reasonMask !== 0).length;
    checks.push({
      id: 'runtime',
      status: value.blockedRequestCount > 0 ? 'critical' : incidentCount > 0 ? 'attention' : 'ok',
      summary: value.blockedRequestCount > 0
        ? value.blockedRequestCount + ' request(s) are blocked.'
        : incidentCount > 0
          ? incidentCount + ' long-running/open-transaction session(s) need review.'
          : 'No current blocking or threshold incident was detected.',
      detail: 'active=' + value.activeRequestCount + ', blocked=' + value.blockedRequestCount +
        ', rootBlockers=' + value.rootBlockerSessionIds.join(',')
    });
    limitations.push(...value.limitations);
  } else {
    checks.push({
      id: 'runtime',
      status: 'unavailable',
      summary: 'Live runtime health could not be read.',
      detail: settledError(live)
    });
    limitations.push('Live runtime health could not be captured.');
  }

  if (deadlocks.status === 'fulfilled') {
    const value = deadlocks.value;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = value.events.filter(event => {
      const time = event.happenedAt ? Date.parse(event.happenedAt) : Number.NaN;
      return Number.isFinite(time) && time >= cutoff;
    });
    checks.push({
      id: 'deadlocks',
      status: !value.available ? 'unavailable' : recent.length ? 'attention' : 'ok',
      summary: !value.available
        ? 'Deadlock history is unavailable.'
        : recent.length
          ? recent.length + ' deadlock event(s) were found in the last 24 hours.'
          : 'No deadlock event with a timestamp in the last 24 hours was found.',
      detail: 'returnedEvents=' + value.events.length
    });
    limitations.push(...value.limitations);
  } else {
    checks.push({
      id: 'deadlocks',
      status: 'unavailable',
      summary: 'Deadlock history could not be read.',
      detail: settledError(deadlocks)
    });
    limitations.push('Deadlock history could not be captured.');
  }

  if (jobs.status === 'fulfilled') {
    const value = jobs.value;
    checks.push({
      id: 'jobs',
      status: !value.available ? 'unavailable' : value.failedJobCount > 0 ? 'attention' : 'ok',
      summary: !value.available
        ? 'SQL Agent job state is unavailable.'
        : value.failedJobCount > 0
          ? value.failedJobCount + ' SQL Agent job(s) have a failed last outcome.'
          : 'No failed SQL Agent last outcome was found.',
      detail: 'failed=' + value.failedJobCount + ', disabled=' + value.disabledJobCount
    });
    limitations.push(...value.limitations);
  } else {
    checks.push({
      id: 'jobs',
      status: 'unavailable',
      summary: 'SQL Agent job state could not be read.',
      detail: settledError(jobs)
    });
    limitations.push('SQL Agent job state could not be captured.');
  }

  if (growth.status === 'fulfilled') {
    const value = growth.value;
    const used = value.summary.logUsedPercent;
    checks.push({
      id: 'storage-log',
      status: used >= 95 ? 'critical' : used >= 85 ? 'attention' : 'ok',
      summary: used >= 95
        ? 'Transaction log usage is critically high.'
        : used >= 85
          ? 'Transaction log usage is high.'
          : 'Transaction log usage is below the health threshold.',
      detail: 'logUsed=' + used.toFixed(1) + '%, recovery=' + value.log.recoveryModel + ', reuseWait=' + value.log.reuseWait
    });
    limitations.push(...value.limitations);
  } else {
    checks.push({
      id: 'storage-log',
      status: 'unavailable',
      summary: 'Storage/log health could not be read.',
      detail: settledError(growth)
    });
    limitations.push('Storage/log health could not be captured.');
  }

  if (serverHistory.status === 'fulfilled') {
    const value = serverHistory.value;
    checks.push({
      id: 'server-history',
      status: value.available ? 'ok' : 'unavailable',
      summary: value.available
        ? 'Persistent LinkQDiagnostics incident history is available.'
        : 'Persistent LinkQDiagnostics incident history is not installed or unavailable.',
      detail: 'captures=' + value.captures.length
    });
    limitations.push(...value.limitations);
  } else {
    checks.push({
      id: 'server-history',
      status: 'unavailable',
      summary: 'Persistent incident history could not be read.',
      detail: settledError(serverHistory)
    });
    limitations.push('Persistent incident history could not be captured.');
  }

  return {
    connection: connectionId,
    database: connection.database ?? '',
    capturedAt,
    status: overallStatus(checks),
    checks,
    limitations: [...new Set(limitations)],
    elapsedMs: Date.now() - startedAt
  };
}
