import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Root } from '../../shared/types.js';
import { evaluateCommandArgvAllowlist, type CommandAllowlistSettings } from '../../shared/command-allowlist.js';
import { getConfig } from '../../main/config.js';
import { normaliseTimeout, runCommand, type ExecResult } from '../../main/exec.js';
import { resolveSqlServerProfile } from '../../main/database/profiles.js';
import { isContained, resolvePath } from '../../main/sandbox.js';
import {
  executeLivePerformance,
  executeQueryStore,
  executeTableScaleProfile
} from '../investigation/service.js';
import { knowledgeSha256 } from '../knowledge/evidence.js';
import { measureEngineeringPhase } from './performance.js';
import { indexKnowledge } from '../knowledge/service.js';
import type {
  EngineeringIncidentVerificationBinding,
  EngineeringTask,
  EngineeringVerificationFileSnapshot,
  EngineeringVerificationRecord
} from './contracts.js';
import type { ResolvedEngineeringLineage } from './lineage.js';
import { engineeringKnowledgeScope } from './lineage.js';
import { mutateEngineeringScope, readEngineeringScope } from './store.js';
import { getEngineeringTasks } from './task-service.js';
import { getIncidentOutcomes, incidentOutcomeTechnicalBasisHash } from '../knowledge/outcome-service.js';
import {
  commandMatchesEngineeringValidationPurpose,
  inferEngineeringValidationPurpose
} from './validation-purpose.js';

const OUTPUT_CHARS = 12_000;
const MAX_CHANGED_FILES = 256;
const SQL_SCALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QUERY_BINDING_MAX_FILE_BYTES = 2 * 1024 * 1024;
const RUNTIME_CLOCK_SKEW_MS = 5 * 60 * 1000;
const LIVE_HOTSPOT_MAX_AGE_MS = 60 * 60 * 1000;

const commandInputSchema = z.object({
  kind: z.literal('command'),
  taskKey: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  purpose: z.enum(['build', 'test', 'typecheck', 'lint', 'custom']).optional(),
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(8192)).max(128).default([]),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  incidentBinding: z.object({
    scope: z.string().trim().min(1).max(120),
    outcomeKey: z.string().trim().min(1).max(160),
    outcomeBasisHash: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict().optional()
}).strict();

const sqlScaleInputSchema = z.object({
  kind: z.literal('sql_scale'),
  taskKey: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  connection: z.string().trim().min(1).max(64).optional(),
  objectId: z.number().int().positive(),
  runtimeSource: z.enum(['query_store', 'live_performance']).optional(),
  queryContains: z.string().trim().min(4).max(1000).optional(),
  hours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(168)]).optional(),
  sort: z.enum(['duration', 'cpu', 'reads', 'executions']).optional(),
  incidentBinding: z.object({
    scope: z.string().trim().min(1).max(120),
    outcomeKey: z.string().trim().min(1).max(160),
    outcomeBasisHash: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict().optional()
}).strict().superRefine((value, ctx) => {
  if (value.runtimeSource && !value.queryContains) {
    ctx.addIssue({ code: 'custom', path: ['queryContains'], message: 'runtime SQL verification requires queryContains' });
  }
  if (!value.runtimeSource && value.queryContains) {
    ctx.addIssue({ code: 'custom', path: ['runtimeSource'], message: 'queryContains is only valid with runtimeSource' });
  }
  if (value.queryContains) {
    const needle = value.queryContains.trim().toLocaleLowerCase('en-US');
    if (new Set(['select', 'update', 'insert', 'delete', 'merge', 'exec', 'execute', 'from', 'where', 'join', 'dbo']).has(needle)) {
      ctx.addIssue({ code: 'custom', path: ['queryContains'], message: 'runtime SQL verification requires a task-specific identifier or SQL fragment, not a generic SQL keyword' });
    }
  }
});

export const engineeringValidationRunInputSchema = z.discriminatedUnion('kind', [commandInputSchema, sqlScaleInputSchema]);
export type EngineeringValidationRunInput = z.infer<typeof engineeringValidationRunInputSchema>;

export interface EngineeringVerificationDependencies {
  commandPolicy?: CommandAllowlistSettings;
  commandRunner?: (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;
  resolveConnection?: typeof resolveSqlServerProfile;
  tableScale?: typeof executeTableScaleProfile;
  queryStore?: typeof executeQueryStore;
  livePerformance?: typeof executeLivePerformance;
}

function clipped(value: string): string {
  return value.length <= OUTPUT_CHARS ? value : value.slice(0, OUTPUT_CHARS);
}

function verificationMaterial(record: Omit<EngineeringVerificationRecord, 'id' | 'provenanceHash'>): string {
  return JSON.stringify(record);
}

function recordProvenanceHash(record: Omit<EngineeringVerificationRecord, 'id' | 'provenanceHash'>): string {
  return knowledgeSha256('engineering-verification:v1\0' + verificationMaterial(record));
}

function verificationId(
  record: Omit<EngineeringVerificationRecord, 'id' | 'provenanceHash'>,
  provenanceHash: string
): string {
  return knowledgeSha256([
    'engineering-verification-id:v1',
    record.lineageKey,
    record.taskKey,
    String(record.taskRevision),
    record.name,
    record.kind,
    record.createdAt,
    provenanceHash
  ].join('\0'));
}

async function resolveChangedFile(
  resolved: ResolvedEngineeringLineage,
  roots: readonly Root[],
  requested: string
): Promise<{ virtual: string; real: string }> {
  const raw = requested.trim();
  if (!raw) throw new Error('ENGINEERING_VALIDATION_CHANGED_FILE_INVALID: changedFiles contains an empty path');
  const candidate = raw.startsWith('/') || path.isAbsolute(raw) ? raw : path.resolve(resolved.workspace.real, raw);
  const file = await resolvePath(roots, candidate);
  if (!isContained(resolved.workspace.real, file.real)) {
    throw new Error(`ENGINEERING_VALIDATION_FILE_OUTSIDE_PROJECT: ${raw}`);
  }
  const stat = await fs.stat(file.real);
  if (!stat.isFile()) throw new Error(`ENGINEERING_VALIDATION_CHANGED_FILE_NOT_FILE: ${raw}`);
  return file;
}

export async function captureEngineeringTaskFiles(
  task: EngineeringTask,
  resolved: ResolvedEngineeringLineage,
  roots: readonly Root[]
): Promise<EngineeringVerificationFileSnapshot[]> {
  if (!task.changedFiles.length) {
    throw new Error('ENGINEERING_VALIDATION_REQUIRES_CHANGED_FILES: record the implementation files in the Engineering Task Packet before machine validation');
  }
  if (task.changedFiles.length > MAX_CHANGED_FILES) throw new Error('ENGINEERING_VALIDATION_CHANGED_FILES_LIMIT');
  const snapshots = new Array<EngineeringVerificationFileSnapshot>(task.changedFiles.length);
  const errors = new Array<unknown>(task.changedFiles.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, task.changedFiles.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= task.changedFiles.length) return;
      const requested = task.changedFiles[index]!;
      try {
        const file = await resolveChangedFile(resolved, roots, requested);
        snapshots[index] = { path: file.virtual, sha256: knowledgeSha256(await fs.readFile(file.real)) };
      } catch (error) {
        errors[index] = error;
      }
    }
  });
  await Promise.all(workers);
  const firstErrorIndex = errors.findIndex(error => error !== undefined);
  if (firstErrorIndex >= 0) throw errors[firstErrorIndex];
  return snapshots.sort((a, b) => a.path.localeCompare(b.path));
}

export function sameEngineeringTaskFileSnapshots(
  left: readonly EngineeringVerificationFileSnapshot[],
  right: readonly EngineeringVerificationFileSnapshot[]
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other?.path === item.path && other.sha256 === item.sha256;
  });
}

async function appendVerification(
  resolved: ResolvedEngineeringLineage,
  record: EngineeringVerificationRecord
): Promise<EngineeringVerificationRecord> {
  await mutateEngineeringScope(resolved.lineage, current => ({
    ...current,
    lineage: { ...resolved.lineage },
    updatedAt: record.createdAt,
    verifications: [...current.verifications.slice(-1_999), record]
  }));
  return record;
}

function finishRecord(
  base: Omit<EngineeringVerificationRecord, 'id' | 'provenanceHash'>
): EngineeringVerificationRecord {
  const provenanceHash = recordProvenanceHash(base);
  return { ...base, provenanceHash, id: verificationId(base, provenanceHash) };
}

async function taskFor(resolved: ResolvedEngineeringLineage, taskKey: string): Promise<EngineeringTask> {
  const task = (await getEngineeringTasks(resolved.lineage, [taskKey]))[0];
  if (!task) throw new Error(`ENGINEERING_TASK_NOT_FOUND: ${taskKey}`);
  return task;
}

async function resolveIncidentVerificationBinding(
  binding: EngineeringIncidentVerificationBinding | undefined
): Promise<EngineeringIncidentVerificationBinding | null> {
  if (!binding) return null;
  const result = await getIncidentOutcomes(binding.scope, [binding.outcomeKey]);
  const outcome = result.outcomes[0]?.outcome;
  if (!outcome) throw new Error('ENGINEERING_INCIDENT_BINDING_OUTCOME_NOT_FOUND');
  if (!outcome.incidentClass) throw new Error('ENGINEERING_INCIDENT_BINDING_REQUIRES_TYPED_OUTCOME');
  if (outcome.status === 'invalidated') throw new Error('ENGINEERING_INCIDENT_BINDING_OUTCOME_INVALIDATED');
  const currentBasisHash = incidentOutcomeTechnicalBasisHash(outcome);
  if (currentBasisHash !== binding.outcomeBasisHash) {
    throw new Error('ENGINEERING_INCIDENT_BINDING_STALE_OUTCOME_BASIS');
  }
  return {
    scope: binding.scope.trim(),
    outcomeKey: outcome.key,
    outcomeBasisHash: currentBasisHash
  };
}

async function runCommandVerification(
  resolved: ResolvedEngineeringLineage,
  input: Extract<EngineeringValidationRunInput, { kind: 'command' }>,
  roots: readonly Root[],
  deps: EngineeringVerificationDependencies
): Promise<EngineeringVerificationRecord> {
  const task = await taskFor(resolved, input.taskKey);
  const incidentBinding = await resolveIncidentVerificationBinding(input.incidentBinding);
  const expectedValidation = task.validations.find(validation => validation.name === input.name);
  if (!expectedValidation) {
    throw new Error(`ENGINEERING_VALIDATION_NOT_DECLARED: ${input.name} is not listed in the current Engineering Task Packet`);
  }
  const expectedPurpose = expectedValidation.purpose ?? inferEngineeringValidationPurpose(expectedValidation.name);
  if (input.purpose && input.purpose !== expectedPurpose) {
    throw new Error(`ENGINEERING_VALIDATION_PURPOSE_MISMATCH: task requires ${expectedPurpose}, validation_run requested ${input.purpose}`);
  }
  const purpose = expectedPurpose;
  if (!commandMatchesEngineeringValidationPurpose(purpose, input.command, input.args)) {
    throw new Error(`ENGINEERING_VALIDATION_COMMAND_MISMATCH: ${input.command} ${input.args.join(' ')} is not a recognized ${purpose} validation command`);
  }
  const beforeKnowledge = await measureEngineeringPhase('validation.pre_index', () => indexKnowledge({
    scope: engineeringKnowledgeScope(resolved.lineage),
    sources: [{ kind: 'source', path: resolved.workspace.virtual }],
    mode: 'incremental'
  }, roots));
  const before = await captureEngineeringTaskFiles(task, resolved, roots);
  const policy = deps.commandPolicy ?? getConfig().commandAllowlist;
  const policyResult = evaluateCommandArgvAllowlist(policy, [input.command, ...input.args]);
  if (!policyResult.allowed) {
    throw new Error(`COMMAND_NOT_ALLOWED: ${policyResult.detail} No command was run.`);
  }
  const runner = deps.commandRunner ?? runCommand;
  const execution = await measureEngineeringPhase('validation.command', () =>
    runner(input.command, input.args, resolved.workspace.real, normaliseTimeout(input.timeoutMs)));
  const after = await captureEngineeringTaskFiles(task, resolved, roots);
  const afterKnowledge = await measureEngineeringPhase('validation.post_index', () => indexKnowledge({
    scope: engineeringKnowledgeScope(resolved.lineage),
    sources: [{ kind: 'source', path: resolved.workspace.virtual }],
    mode: 'incremental'
  }, roots));
  const sourceStable = sameEngineeringTaskFileSnapshots(before, after) && beforeKnowledge.generation === afterKnowledge.generation;
  const createdAt = new Date().toISOString();
  const stdout = clipped(execution.stdout);
  const stderr = clipped(execution.stderr);
  const success = execution.exitCode === 0 && !execution.timedOut && sourceStable;
  return appendVerification(resolved, finishRecord({
    lineageKey: resolved.lineage.key,
    taskKey: task.key,
    taskRevision: task.revision,
    name: input.name,
    kind: 'command',
    success,
    knowledgeGeneration: afterKnowledge.generation,
    fileSnapshots: after,
    command: {
      purpose,
      command: input.command,
      args: [...input.args],
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      truncated: execution.truncated || execution.stdout.length > OUTPUT_CHARS || execution.stderr.length > OUTPUT_CHARS,
      durationMs: Math.max(0, Math.round(execution.durationMs)),
      stdout,
      stderr: sourceStable ? stderr : clipped([stderr, 'ENGINEERING_VALIDATION_SOURCE_CHANGED_DURING_RUN'].filter(Boolean).join('\n')),
      stdoutHash: knowledgeSha256(execution.stdout),
      stderrHash: knowledgeSha256(execution.stderr)
    },
    scale: null,
    incidentBinding,
    createdAt
  }));
}

function includesQuery(sql: string | null, needle: string): boolean {
  return Boolean(sql?.toLocaleLowerCase('en-US').includes(needle.toLocaleLowerCase('en-US')));
}

function referencesTable(sql: string | null, schema: string, table: string): boolean {
  if (!sql) return false;
  const normalizedSql = sql
    .toLocaleLowerCase('en-US')
    .replace(/[\[\]"`]/g, '')
    .replace(/\s+/g, ' ');
  const normalizedSchema = schema.toLocaleLowerCase('en-US');
  const normalizedTable = table.toLocaleLowerCase('en-US');
  if (normalizedSql.includes(`${normalizedSchema}.${normalizedTable}`)) return true;
  const escaped = normalizedTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(normalizedSql);
}

function recentTimestamp(value: string | null, maxAgeMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= -RUNTIME_CLOCK_SKEW_MS && age <= maxAgeMs + RUNTIME_CLOCK_SKEW_MS;
}

async function bindRuntimeNeedleToTask(
  task: EngineeringTask,
  resolved: ResolvedEngineeringLineage,
  roots: readonly Root[],
  needle: string
): Promise<'task_text' | 'changed_file'> {
  const normalizedNeedle = needle.toLocaleLowerCase('en-US');
  const taskText = [task.goal, ...task.requirements, ...task.decisions].join('\n').toLocaleLowerCase('en-US');
  if (taskText.includes(normalizedNeedle)) return 'task_text';
  for (const requested of task.changedFiles) {
    const file = await resolveChangedFile(resolved, roots, requested);
    const stat = await fs.stat(file.real);
    if (!stat.isFile() || stat.size > QUERY_BINDING_MAX_FILE_BYTES) continue;
    const content = await fs.readFile(file.real, 'utf8');
    if (!content.includes('\u0000') && content.toLocaleLowerCase('en-US').includes(normalizedNeedle)) return 'changed_file';
  }
  throw new Error(
    `ENGINEERING_SQL_QUERY_NOT_BOUND_TO_TASK: ${needle} does not occur in the task goal/requirements/decisions or changed implementation files`
  );
}

async function runSqlScaleVerification(
  resolved: ResolvedEngineeringLineage,
  input: Extract<EngineeringValidationRunInput, { kind: 'sql_scale' }>,
  roots: readonly Root[],
  deps: EngineeringVerificationDependencies
): Promise<EngineeringVerificationRecord> {
  const task = await taskFor(resolved, input.taskKey);
  const incidentBinding = await resolveIncidentVerificationBinding(input.incidentBinding);
  const beforeKnowledge = await measureEngineeringPhase('validation.pre_index', () => indexKnowledge({
    scope: engineeringKnowledgeScope(resolved.lineage),
    sources: [{ kind: 'source', path: resolved.workspace.virtual }],
    mode: 'incremental'
  }, roots));
  const beforeFiles = await captureEngineeringTaskFiles(task, resolved, roots);
  const resolveConnection = deps.resolveConnection ?? resolveSqlServerProfile;
  const selected = await resolveConnection(input.connection);
  const tableScale = deps.tableScale ?? executeTableScaleProfile;
  const table = await tableScale({ connection: selected.id, objectId: input.objectId });
  const limitations = [...table.limitations];
  let matchedRuntimeCount = 0;
  let runtimeSource: 'none' | 'query_store' | 'live_performance' = 'none';
  let queryBinding: 'none' | 'task_text' | 'changed_file' = 'none';
  let runtimeCapture: unknown = null;
  if (input.runtimeSource && input.queryContains) {
    runtimeSource = input.runtimeSource;
    queryBinding = await bindRuntimeNeedleToTask(task, resolved, roots, input.queryContains);
    try {
      if (input.runtimeSource === 'query_store') {
        const queryStore = deps.queryStore ?? executeQueryStore;
        const hours = input.hours ?? 24;
        const runtime = await queryStore({ connection: selected.id, hours, sort: input.sort });
        const matched = runtime.queries.filter(row =>
          includesQuery(row.sql, input.queryContains!)
          && referencesTable(row.sql, table.object.schema, table.object.table)
          && row.executionCount > 0
          && recentTimestamp(row.lastExecutionAt, hours * 60 * 60 * 1000)
        );
        matchedRuntimeCount = matched.length;
        limitations.push(...runtime.limitations);
        runtimeCapture = {
          available: runtime.available,
          actualState: runtime.actualState,
          capturedAt: runtime.capturedAt,
          matched: matched.slice(0, 20).map(row => ({
            queryId: row.queryId,
            planId: row.planId,
            executionCount: row.executionCount,
            avgDurationMs: row.avgDurationMs,
            avgCpuMs: row.avgCpuMs,
            avgLogicalReads: row.avgLogicalReads,
            lastExecutionAt: row.lastExecutionAt
          }))
        };
      } else {
        const livePerformance = deps.livePerformance ?? executeLivePerformance;
        const runtime = await livePerformance(selected.id);
        const requestMatches = runtime.requests.filter(row =>
          includesQuery(row.sql, input.queryContains!)
          && referencesTable(row.sql, table.object.schema, table.object.table)
        );
        const hotspotMatches = runtime.hotspots.filter(row =>
          includesQuery(row.sql, input.queryContains!)
          && referencesTable(row.sql, table.object.schema, table.object.table)
          && row.executionCount > 0
          && recentTimestamp(row.lastExecutionAt, LIVE_HOTSPOT_MAX_AGE_MS)
        );
        matchedRuntimeCount = requestMatches.length + hotspotMatches.length;
        limitations.push(...runtime.limitations);
        runtimeCapture = {
          capturedAt: runtime.capturedAt,
          activeRequestCount: runtime.activeRequestCount,
          matchedRequests: requestMatches.length,
          matchedHotspots: hotspotMatches.slice(0, 20).map(row => ({
            executionCount: row.executionCount,
            avgElapsedMs: row.avgElapsedMs,
            totalLogicalReads: row.totalLogicalReads,
            lastExecutionAt: row.lastExecutionAt
          }))
        };
      }
    } catch (error) {
      limitations.push(`Runtime scale verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const runtimeVerified = Boolean(input.runtimeSource && input.queryContains && matchedRuntimeCount > 0);
  const afterFiles = await captureEngineeringTaskFiles(task, resolved, roots);
  const afterKnowledge = await measureEngineeringPhase('validation.post_index', () => indexKnowledge({
    scope: engineeringKnowledgeScope(resolved.lineage),
    sources: [{ kind: 'source', path: resolved.workspace.virtual }],
    mode: 'incremental'
  }, roots));
  const sourceStable = sameEngineeringTaskFileSnapshots(beforeFiles, afterFiles) && beforeKnowledge.generation === afterKnowledge.generation;
  const scaleMaterial = {
    table: {
      connection: table.connection,
      database: table.database,
      capturedAt: table.capturedAt,
      object: table.object,
      approximateRows: table.approximateRows,
      reservedMb: table.reservedMb,
      usedMb: table.usedMb,
      dataMb: table.dataMb,
      indexes: table.indexes,
      statistics: table.statistics
    },
    runtime: runtimeCapture
  };
  const createdAt = new Date().toISOString();
  return appendVerification(resolved, finishRecord({
    lineageKey: resolved.lineage.key,
    taskKey: task.key,
    taskRevision: task.revision,
    name: input.name,
    kind: 'sql_scale',
    success: sourceStable && (input.runtimeSource ? runtimeVerified : true),
    knowledgeGeneration: afterKnowledge.generation,
    fileSnapshots: afterFiles,
    command: null,
    scale: {
      connection: table.connection,
      database: table.database,
      objectId: table.object.objectId,
      objectName: `${table.object.schema}.${table.object.table}`,
      approximateRows: table.approximateRows,
      indexCount: table.indexes.length,
      statisticsCount: table.statistics.length,
      level: runtimeVerified ? 'runtime' : 'static',
      runtimeSource,
      queryContains: input.queryContains ?? null,
      queryBinding,
      matchedRuntimeCount,
      capturedAt: table.capturedAt,
      resultHash: knowledgeSha256(JSON.stringify(scaleMaterial)),
      limitations: [...new Set(limitations)].slice(0, 100)
    },
    incidentBinding,
    createdAt
  }));
}

export async function runEngineeringValidation(
  resolved: ResolvedEngineeringLineage,
  rawInput: unknown,
  roots: readonly Root[],
  deps: EngineeringVerificationDependencies = {}
): Promise<EngineeringVerificationRecord> {
  const input = engineeringValidationRunInputSchema.parse(rawInput);
  return input.kind === 'command'
    ? runCommandVerification(resolved, input, roots, deps)
    : runSqlScaleVerification(resolved, input, roots, deps);
}

export async function getEngineeringVerifications(
  lineage: ResolvedEngineeringLineage['lineage'],
  taskKey: string
): Promise<EngineeringVerificationRecord[]> {
  const snapshot = await readEngineeringScope(lineage);
  return snapshot.verifications
    .filter(record => record.taskKey === taskKey.trim())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function verifyEngineeringVerification(
  record: EngineeringVerificationRecord,
  task: EngineeringTask,
  resolved: ResolvedEngineeringLineage,
  roots: readonly Root[],
  currentKnowledgeGeneration: string,
  currentFileSnapshots?: readonly EngineeringVerificationFileSnapshot[]
): Promise<{ current: boolean; reason: string | null }> {
  if (record.lineageKey !== resolved.lineage.key || record.taskKey !== task.key) {
    return { current: false, reason: 'verification belongs to another engineering lineage or task' };
  }
  if (record.taskRevision !== task.revision) return { current: false, reason: 'task revision changed after verification' };
  if (record.kind === 'sql_scale' && Date.now() - Date.parse(record.createdAt) > SQL_SCALE_MAX_AGE_MS) {
    return { current: false, reason: 'SQL runtime/scale evidence is older than the 24-hour verification window' };
  }
  if (record.knowledgeGeneration !== currentKnowledgeGeneration) return { current: false, reason: 'project source knowledge changed after verification' };
  const { id: _id, provenanceHash: _hash, ...base } = record;
  if (recordProvenanceHash(base) !== record.provenanceHash || verificationId(base, record.provenanceHash) !== record.id) {
    return { current: false, reason: 'verification provenance hash does not match the stored record' };
  }
  let currentFiles: readonly EngineeringVerificationFileSnapshot[];
  if (currentFileSnapshots) currentFiles = currentFileSnapshots;
  else try {
    currentFiles = await captureEngineeringTaskFiles(task, resolved, roots);
  } catch (error) {
    return { current: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!sameEngineeringTaskFileSnapshots(record.fileSnapshots, currentFiles)) return { current: false, reason: 'one or more implementation files changed after verification' };
  return { current: true, reason: null };
}
