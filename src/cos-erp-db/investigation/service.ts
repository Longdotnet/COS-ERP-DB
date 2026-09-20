import { randomUUID } from 'node:crypto';
import type {
  DatabaseColumnProfileRequest,
  DatabaseColumnProfileResult,
  DatabaseColumnSearchResult,
  DatabaseFieldConsumerRequest,
  DatabaseFieldConsumersResult,
  DatabaseIncidentHistoryResult,
  DatabaseIncidentCauseTraceRequest,
  DatabaseIncidentCauseTraceResult,
  DatabaseIncidentSnapshot,
  DatabaseJobsResult,
  DatabaseLivePerformanceResult,
  DatabaseDeadlockHistoryResult,
  DatabaseQueryStoreRequest,
  DatabaseQueryStoreResult,
  DatabaseSchemaCompareRequest,
  DatabaseSchemaCompareResult,
  DatabaseServerIncidentHistoryResult,
  DatabaseSourceTraceRequest,
  DatabaseSourceTraceResult
} from './types.js';
import { resolveSqlServerProfile } from '../../main/database/profiles.js';
import { readSqlServerGrowthDiagnostics } from '../../main/database/growth-diagnostics.js';
import {
  compareSqlServerSchemas,
  profileSqlServerColumn,
  readSqlServerDeadlocks,
  readSqlServerFieldConsumers,
  readSqlServerJobs,
  readSqlServerDiagnosticHistory,
  readSqlServerLivePerformance,
  readSqlServerQueryStore,
  searchSqlServerColumns
} from './sqlserver-investigator.js';
import { traceApplicationSource } from './source-trace.js';
import { traceApplicationObjectTerms } from './source-trace.js';
import { extractIncidentCauseCandidates } from './incident-cause.js';
import {
  deleteDatabaseIncidentSnapshot,
  clearDatabaseIncidentHistory,
  readDatabaseIncidentHistory,
  saveDatabaseIncidentSnapshot
} from './incident-history.js';

async function resolved(connectionId?: string) {
  try {
    return await resolveSqlServerProfile(connectionId);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function redact(error: unknown, password: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  if (password) message = message.split(password).join('[redacted]');
  return new Error(message);
}

export async function executeColumnSearch(connectionId: string, search: string): Promise<DatabaseColumnSearchResult> {
  const profile = await resolved(connectionId);
  try {
    return await searchSqlServerColumns(profile.id, profile.connection, search);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeColumnProfile(request: DatabaseColumnProfileRequest): Promise<DatabaseColumnProfileResult> {
  const profile = await resolved(request.connection);
  try {
    return await profileSqlServerColumn(profile.id, profile.connection, request.objectId, request.column);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeFieldConsumers(request: DatabaseFieldConsumerRequest): Promise<DatabaseFieldConsumersResult> {
  const profile = await resolved(request.connection);
  try {
    return await readSqlServerFieldConsumers(profile.id, profile.connection, request.objectId, request.column);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeLivePerformance(connectionId: string): Promise<DatabaseLivePerformanceResult> {
  const profile = await resolved(connectionId);
  try {
    return await readSqlServerLivePerformance(profile.id, profile.connection);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeQueryStore(request: DatabaseQueryStoreRequest): Promise<DatabaseQueryStoreResult> {
  const profile = await resolved(request.connection);
  try {
    return await readSqlServerQueryStore(profile.id, profile.connection, { hours: request.hours, sort: request.sort });
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeDeadlocks(connectionId: string): Promise<DatabaseDeadlockHistoryResult> {
  const profile = await resolved(connectionId);
  try {
    return await readSqlServerDeadlocks(profile.id, profile.connection);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeSourceTrace(request: DatabaseSourceTraceRequest): Promise<DatabaseSourceTraceResult> {
  const profile = await resolved(request.connection);
  try {
    const flow = await readSqlServerFieldConsumers(profile.id, profile.connection, request.objectId, request.column);
    return await traceApplicationSource(profile.id, profile.connection.database ?? '', flow, request.sourceRoot);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeIncidentCauseTrace(request: DatabaseIncidentCauseTraceRequest): Promise<DatabaseIncidentCauseTraceResult> {
  const startedAt = Date.now();
  const profile = await resolved(request.connection);
  const sql = request.sql.slice(0, 8_000);
  const candidates = extractIncidentCauseCandidates(sql);
  const limitations: string[] = [];
  let confirmedField: DatabaseColumnProfileResult['column'] | null = null;
  let consumers: DatabaseFieldConsumersResult['consumers'] = [];
  let source: DatabaseIncidentCauseTraceResult['source'] = null;

  try {
    const columnCandidates = candidates.filter(candidate => candidate.kind === 'column').slice(0, 6);
    for (const candidate of columnCandidates) {
      const search = await searchSqlServerColumns(profile.id, profile.connection, candidate.name);
      const matches = search.matches.filter(match =>
        match.column.toLowerCase() === candidate.name.toLowerCase()
        && (!candidate.table || match.table.toLowerCase() === candidate.table.toLowerCase())
        && (!candidate.schema || match.schema.toLowerCase() === candidate.schema.toLowerCase()));
      const exact = candidate.schema
        ? matches[0]
        : matches.length === 1
          ? matches[0]
          : undefined;
      if (!candidate.schema && matches.length > 1) {
        limitations.push(`Column ${candidate.name} matched multiple schemas for ${candidate.table ?? 'the detected table'}; no field was auto-selected.`);
      }
      if (!exact) continue;
      confirmedField = exact;
      const flow = await readSqlServerFieldConsumers(profile.id, profile.connection, exact.objectId, exact.column);
      consumers = flow.consumers;
      const traced = await traceApplicationSource(profile.id, profile.connection.database ?? '', flow, request.sourceRoot);
      source = {
        sourceRoot: traced.sourceRoot,
        searchedFiles: traced.searchedFiles,
        skippedFiles: traced.skippedFiles,
        matches: traced.matches,
        truncated: traced.truncated,
        limitations: traced.limitations,
        elapsedMs: traced.elapsedMs
      };
      limitations.push(...flow.limitations);
      break;
    }

    if (!source) {
      const procedure = candidates.find(candidate => candidate.kind === 'procedure');
      const table = candidates.find(candidate => candidate.kind === 'table');
      if (procedure || table) {
        source = await traceApplicationObjectTerms(request.sourceRoot, {
          procedures: procedure
            ? [procedure.name, ...(procedure.schema ? [`${procedure.schema}.${procedure.name}`] : [])]
            : [],
          table: table?.name ?? null
        });
      }
    }
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }

  if (!candidates.length) limitations.push('No reliable stored procedure, table or explicit DML column could be extracted from this SQL text.');
  else if (!confirmedField && candidates.some(candidate => candidate.kind === 'column')) {
    limitations.push('Explicit SQL columns were found but could not be confirmed against the selected database metadata.');
  }
  if (!source) limitations.push('Source trace was not run because the statement did not contain a reliable object or confirmed field candidate.');

  return {
    connection: profile.id,
    database: profile.connection.database ?? '',
    candidates,
    confirmedField,
    consumers,
    source,
    limitations: [...new Set(limitations)],
    elapsedMs: Date.now() - startedAt
  };
}

export async function executeJobs(connectionId: string): Promise<DatabaseJobsResult> {
  const profile = await resolved(connectionId);
  try {
    return await readSqlServerJobs(profile.id, profile.connection);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeServerIncidentHistory(connectionId?: string): Promise<DatabaseServerIncidentHistoryResult> {
  const profile = await resolved(connectionId);
  try {
    return await readSqlServerDiagnosticHistory(profile.id, profile.connection);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }
}

export async function executeSchemaCompare(request: DatabaseSchemaCompareRequest): Promise<DatabaseSchemaCompareResult> {
  if (request.baselineConnection.toLowerCase() === request.currentConnection.toLowerCase()) {
    throw new Error('Baseline and Current must be different database connections.');
  }
  const [baseline, current] = await Promise.all([
    resolved(request.baselineConnection),
    resolved(request.currentConnection)
  ]);
  try {
    return await compareSqlServerSchemas(
      baseline.id,
      baseline.connection,
      current.id,
      current.connection
    );
  } catch (error) {
    throw redact(redact(error, baseline.connection.authentication.password), current.connection.authentication.password);
  }
}

export async function diagnoseIncident(connectionId?: string): Promise<DatabaseIncidentSnapshot> {
  const profile = await resolved(connectionId);
  const capturedAt = new Date().toISOString();
  const [growthSettled, performanceSettled, jobsSettled] = await Promise.allSettled([
    readSqlServerGrowthDiagnostics(profile.connection),
    readSqlServerLivePerformance(profile.id, profile.connection),
    readSqlServerJobs(profile.id, profile.connection)
  ]);
  const limitations: string[] = [];
  const growth = growthSettled.status === 'fulfilled' ? growthSettled.value : null;
  const performance = performanceSettled.status === 'fulfilled' ? performanceSettled.value : null;
  const jobs = jobsSettled.status === 'fulfilled' ? jobsSettled.value : null;
  if (!growth) limitations.push(`Storage/log diagnostics failed: ${growthSettled.status === 'rejected' ? (growthSettled.reason instanceof Error ? growthSettled.reason.message : String(growthSettled.reason)) : 'unknown error'}`);
  if (!performance) limitations.push(`Live performance capture failed: ${performanceSettled.status === 'rejected' ? (performanceSettled.reason instanceof Error ? performanceSettled.reason.message : String(performanceSettled.reason)) : 'unknown error'}`);
  if (!jobs) limitations.push(`SQL Agent capture failed: ${jobsSettled.status === 'rejected' ? (jobsSettled.reason instanceof Error ? jobsSettled.reason.message : String(jobsSettled.reason)) : 'unknown error'}`);
  limitations.push(...(growth?.limitations ?? []), ...(performance?.limitations ?? []), ...(jobs?.limitations ?? []));
  const snapshot: DatabaseIncidentSnapshot = {
    id: randomUUID(),
    connection: profile.id,
    database: profile.connection.database ?? '',
    capturedAt,
    savedAt: null,
    summary: {
      totalMb: growth?.summary.totalMb ?? null,
      dataUsedMb: growth?.summary.dataUsedMb ?? null,
      logUsedPercent: growth?.summary.logUsedPercent ?? null,
      activeRequestCount: performance?.activeRequestCount ?? 0,
      blockedRequestCount: performance?.incidentSessions.filter(session => (session.reasonMask & 1) !== 0).length ?? 0,
      failedJobCount: jobs?.available ? jobs.failedJobCount : null
    },
    requests: (performance?.incidentSessions ?? []).slice(0, 80),
    jobs: (jobs?.jobs ?? []).slice(0, 200),
    findings: (growth?.findings ?? []).map(finding => ({ severity: finding.severity, title: finding.title, detail: finding.detail })),
    limitations: [...new Set(limitations)].map(item => {
      const password = profile.connection.authentication.password;
      return password ? item.split(password).join('[redacted]') : item;
    })
  };
  return snapshot;
}

export async function diagnoseIncidentForWatch(connectionId: string): Promise<DatabaseIncidentSnapshot> {
  const profile = await resolved(connectionId);
  let performance: DatabaseLivePerformanceResult;
  try {
    performance = await readSqlServerLivePerformance(profile.id, profile.connection);
  } catch (error) {
    throw redact(error, profile.connection.authentication.password);
  }

  const hasIncident = performance.incidentSessions.some(session => session.reasonMask !== 0);
  if (!hasIncident) {
    return {
      id: randomUUID(),
      connection: profile.id,
      database: profile.connection.database ?? '',
      capturedAt: performance.capturedAt,
      savedAt: null,
      summary: {
        totalMb: null,
        dataUsedMb: null,
        logUsedPercent: null,
        activeRequestCount: performance.activeRequestCount,
        blockedRequestCount: performance.incidentSessions.filter(session => (session.reasonMask & 1) !== 0).length,
        failedJobCount: null
      },
      requests: performance.incidentSessions.slice(0, 80),
      jobs: [],
      findings: [],
      limitations: performance.limitations
    };
  }

  const [growthSettled, jobsSettled] = await Promise.allSettled([
    readSqlServerGrowthDiagnostics(profile.connection),
    readSqlServerJobs(profile.id, profile.connection)
  ]);
  const growth = growthSettled.status === 'fulfilled' ? growthSettled.value : null;
  const jobs = jobsSettled.status === 'fulfilled' ? jobsSettled.value : null;
  const limitations = [
    ...performance.limitations,
    ...(growth?.limitations ?? []),
    ...(jobs?.limitations ?? [])
  ];
  if (!growth && growthSettled.status === 'rejected') {
    limitations.push(`Storage/log diagnostics failed: ${growthSettled.reason instanceof Error ? growthSettled.reason.message : String(growthSettled.reason)}`);
  }
  if (!jobs && jobsSettled.status === 'rejected') {
    limitations.push(`SQL Agent capture failed: ${jobsSettled.reason instanceof Error ? jobsSettled.reason.message : String(jobsSettled.reason)}`);
  }

  const password = profile.connection.authentication.password;
  return {
    id: randomUUID(),
    connection: profile.id,
    database: profile.connection.database ?? '',
    capturedAt: performance.capturedAt,
    savedAt: null,
    summary: {
      totalMb: growth?.summary.totalMb ?? null,
      dataUsedMb: growth?.summary.dataUsedMb ?? null,
      logUsedPercent: growth?.summary.logUsedPercent ?? null,
      activeRequestCount: performance.activeRequestCount,
      blockedRequestCount: performance.incidentSessions.filter(session => (session.reasonMask & 1) !== 0).length,
      failedJobCount: jobs?.available ? jobs.failedJobCount : null
    },
    requests: performance.incidentSessions.slice(0, 80),
    jobs: (jobs?.jobs ?? []).slice(0, 200),
    findings: (growth?.findings ?? []).map(finding => ({ severity: finding.severity, title: finding.title, detail: finding.detail })),
    limitations: [...new Set(limitations)].map(item => password ? item.split(password).join('[redacted]') : item)
  };
}

export async function captureIncident(connectionId: string): Promise<DatabaseIncidentHistoryResult> {
  return saveDatabaseIncidentSnapshot(await diagnoseIncident(connectionId));
}

export function readIncidentHistory(connectionId: string): Promise<DatabaseIncidentHistoryResult> {
  return readDatabaseIncidentHistory(connectionId);
}

export function deleteIncident(connectionId: string, snapshotId: string): Promise<DatabaseIncidentHistoryResult> {
  return deleteDatabaseIncidentSnapshot(connectionId, snapshotId);
}

export function clearIncidentHistory(connectionId: string): Promise<DatabaseIncidentHistoryResult> {
  return clearDatabaseIncidentHistory(connectionId);
}
