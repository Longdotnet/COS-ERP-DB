import type {
  DatabaseGrowthCapture,
  DatabaseGrowthComparisonResult,
  DatabaseGrowthFileDelta,
  DatabaseGrowthFileSummary,
  DatabaseGrowthSchemaDelta,
  DatabaseGrowthTableDelta,
  DatabaseGrowthTableFingerprint,
  DatabaseGrowthTableSummary
} from '../../shared/database.js';

export const MAX_RETURNED_GROWTH_TABLE_DELTAS = 100;
export const MAX_RETURNED_GROWTH_SCHEMA_DELTAS = 100;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function tableKey(table: Pick<DatabaseGrowthTableSummary, 'schema' | 'name'>): string {
  return `${table.schema}\u0000${table.name}`;
}

function fileKey(file: Pick<DatabaseGrowthFileSummary, 'type' | 'name'>): string {
  return `${file.type}\u0000${file.name}`;
}

function fingerprintKey(fingerprint: Pick<DatabaseGrowthTableFingerprint, 'schema' | 'name'>): string {
  return `${fingerprint.schema}\u0000${fingerprint.name}`;
}

function tableDelta(
  before: DatabaseGrowthTableSummary | undefined,
  after: DatabaseGrowthTableSummary | undefined
): DatabaseGrowthTableDelta {
  const identity = after ?? before!;
  const baselineRows = before?.rows ?? 0;
  const currentRows = after?.rows ?? 0;
  const baselineReservedMb = before?.reservedMb ?? 0;
  const currentReservedMb = after?.reservedMb ?? 0;
  const baselineUsedMb = before?.usedMb ?? 0;
  const currentUsedMb = after?.usedMb ?? 0;
  const baselineDataMb = before?.dataMb ?? 0;
  const currentDataMb = after?.dataMb ?? 0;
  const baselineIndexMb = before?.indexMb ?? 0;
  const currentIndexMb = after?.indexMb ?? 0;
  return {
    schema: identity.schema,
    name: identity.name,
    state: before && after ? 'matched' : after ? 'added' : 'removed',
    baselineObjectId: before?.objectId ?? null,
    currentObjectId: after?.objectId ?? null,
    baselineRows,
    currentRows,
    rowDelta: currentRows - baselineRows,
    baselineReservedMb,
    currentReservedMb,
    reservedDeltaMb: round(currentReservedMb - baselineReservedMb),
    baselineUsedMb,
    currentUsedMb,
    usedDeltaMb: round(currentUsedMb - baselineUsedMb),
    baselineDataMb,
    currentDataMb,
    dataDeltaMb: round(currentDataMb - baselineDataMb),
    baselineIndexMb,
    currentIndexMb,
    indexDeltaMb: round(currentIndexMb - baselineIndexMb)
  };
}

function fileDelta(
  before: DatabaseGrowthFileSummary | undefined,
  after: DatabaseGrowthFileSummary | undefined
): DatabaseGrowthFileDelta {
  const identity = after ?? before!;
  const baselineSizeMb = before?.sizeMb ?? 0;
  const currentSizeMb = after?.sizeMb ?? 0;
  const baselineUsedMb = before?.usedMb ?? null;
  const currentUsedMb = after?.usedMb ?? null;
  return {
    name: identity.name,
    type: identity.type,
    state: before && after ? 'matched' : after ? 'added' : 'removed',
    baselineSizeMb,
    currentSizeMb,
    sizeDeltaMb: round(currentSizeMb - baselineSizeMb),
    baselineUsedMb,
    currentUsedMb,
    usedDeltaMb: baselineUsedMb === null || currentUsedMb === null
      ? null
      : round(currentUsedMb - baselineUsedMb)
  };
}

function isTableDifference(delta: DatabaseGrowthTableDelta): boolean {
  return delta.state !== 'matched'
    || Math.abs(delta.reservedDeltaMb) >= 0.005
    || Math.abs(delta.usedDeltaMb) >= 0.005
    || Math.abs(delta.rowDelta) >= 0.5;
}

function isFileDifference(delta: DatabaseGrowthFileDelta): boolean {
  return delta.state !== 'matched'
    || Math.abs(delta.sizeDeltaMb) >= 0.005
    || (delta.usedDeltaMb !== null && Math.abs(delta.usedDeltaMb) >= 0.005);
}

function schemaDelta(
  before: DatabaseGrowthTableFingerprint,
  after: DatabaseGrowthTableFingerprint,
  beforeTable: DatabaseGrowthTableSummary,
  afterTable: DatabaseGrowthTableSummary
): DatabaseGrowthSchemaDelta | null {
  const columnChanged = before.columnCount !== after.columnCount || before.columnHash !== after.columnHash;
  const indexChanged = before.indexCount !== after.indexCount || before.indexHash !== after.indexHash;
  if (!columnChanged && !indexChanged) return null;
  return {
    schema: after.schema,
    name: after.name,
    baselineObjectId: beforeTable.objectId,
    currentObjectId: afterTable.objectId,
    columnChanged,
    indexChanged,
    baselineColumnCount: before.columnCount,
    currentColumnCount: after.columnCount,
    baselineIndexCount: before.indexCount,
    currentIndexCount: after.indexCount
  };
}

/** Pure comparison: all attribution is computed before the UI-sized table list is truncated. */
export function compareDatabaseGrowthCaptures(
  baselineConnection: string,
  baseline: DatabaseGrowthCapture,
  currentConnection: string,
  current: DatabaseGrowthCapture,
  metadata: {
    baselineAsOf?: string;
    baselineSource?: 'live' | 'snapshot';
    baselineSnapshotId?: string;
    currentSource?: 'live' | 'snapshot';
    currentSnapshotId?: string;
  } = {}
): DatabaseGrowthComparisonResult {
  const beforeTables = new Map(baseline.tables.map(table => [tableKey(table), table]));
  const afterTables = new Map(current.tables.map(table => [tableKey(table), table]));
  const tableKeys = new Set([...beforeTables.keys(), ...afterTables.keys()]);
  const allTableDeltas = [...tableKeys]
    .map(key => tableDelta(beforeTables.get(key), afterTables.get(key)))
    .filter(isTableDifference);
  const addedTableCount = allTableDeltas.filter(delta => delta.state === 'added').length;
  const removedTableCount = allTableDeltas.filter(delta => delta.state === 'removed').length;

  const tableUsedDeltaMb = round(allTableDeltas.reduce((sum, delta) => sum + delta.usedDeltaMb, 0));
  const dataUsedDeltaMb = round(current.summary.dataUsedMb - baseline.summary.dataUsedMb);
  const unattributedDataUsedDeltaMb = round(dataUsedDeltaMb - tableUsedDeltaMb);
  const sameDirection = dataUsedDeltaMb === 0 || tableUsedDeltaMb === 0 || Math.sign(dataUsedDeltaMb) === Math.sign(tableUsedDeltaMb);
  const attributionPercent = Math.abs(dataUsedDeltaMb) < 0.005
    ? null
    : round(sameDirection ? Math.min(100, Math.abs(tableUsedDeltaMb) / Math.abs(dataUsedDeltaMb) * 100) : 0);

  const sortedTableDeltas = allTableDeltas
    .slice()
    .sort((left, right) => {
      const used = Math.abs(right.usedDeltaMb) - Math.abs(left.usedDeltaMb);
      if (used !== 0) return used;
      const reserved = Math.abs(right.reservedDeltaMb) - Math.abs(left.reservedDeltaMb);
      if (reserved !== 0) return reserved;
      return `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`);
    });

  const beforeFiles = new Map(baseline.files.map(file => [fileKey(file), file]));
  const afterFiles = new Map(current.files.map(file => [fileKey(file), file]));
  const fileKeys = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  const fileDeltas = [...fileKeys]
    .map(key => fileDelta(beforeFiles.get(key), afterFiles.get(key)))
    .filter(isFileDifference)
    .sort((left, right) => Math.abs(right.sizeDeltaMb) - Math.abs(left.sizeDeltaMb));

  const beforeFingerprints = new Map(baseline.tableFingerprints.map(fingerprint => [fingerprintKey(fingerprint), fingerprint]));
  const afterFingerprints = new Map(current.tableFingerprints.map(fingerprint => [fingerprintKey(fingerprint), fingerprint]));
  const allSchemaDeltas: DatabaseGrowthSchemaDelta[] = [];
  for (const [key, before] of beforeFingerprints) {
    const after = afterFingerprints.get(key);
    const beforeTable = beforeTables.get(key);
    const afterTable = afterTables.get(key);
    if (!after || !beforeTable || !afterTable) continue;
    const delta = schemaDelta(before, after, beforeTable, afterTable);
    if (delta) allSchemaDeltas.push(delta);
  }
  allSchemaDeltas.sort((left, right) => {
    const severity = Number(right.columnChanged) + Number(right.indexChanged) - Number(left.columnChanged) - Number(left.indexChanged);
    if (severity !== 0) return severity;
    return `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`);
  });

  const limitations = [...new Set([
    ...baseline.limitations.map(item => `Baseline: ${item}`),
    ...current.limitations.map(item => `Current: ${item}`),
    ...(baseline.tablesTruncated || current.tablesTruncated
      ? ['Table attribution is incomplete because at least one capture reached the table capture limit.']
      : []),
    ...(baseline.schemaTruncated || current.schemaTruncated
      ? ['Column/index drift is incomplete because at least one source lacks a complete schema fingerprint capture.']
      : ['Column/index drift uses compact SQL Server metadata fingerprints and is not a full DDL equivalence check.'])
  ])];

  const returned = sortedTableDeltas.slice(0, MAX_RETURNED_GROWTH_TABLE_DELTAS);
  const returnedSchema = allSchemaDeltas.slice(0, MAX_RETURNED_GROWTH_SCHEMA_DELTAS);
  return {
    baseline: {
      connection: baselineConnection,
      database: baseline.database,
      capturedAt: baseline.capturedAt,
      ...(metadata.baselineAsOf ? { asOf: metadata.baselineAsOf } : {}),
      source: metadata.baselineSource ?? 'live',
      ...(metadata.baselineSnapshotId ? { snapshotId: metadata.baselineSnapshotId } : {}),
      tablesTruncated: baseline.tablesTruncated,
      schemaTruncated: baseline.schemaTruncated
    },
    current: {
      connection: currentConnection,
      database: current.database,
      capturedAt: current.capturedAt,
      source: metadata.currentSource ?? 'live',
      ...(metadata.currentSnapshotId ? { snapshotId: metadata.currentSnapshotId } : {}),
      tablesTruncated: current.tablesTruncated,
      schemaTruncated: current.schemaTruncated
    },
    summary: {
      totalAllocatedDeltaMb: round(current.summary.totalMb - baseline.summary.totalMb),
      dataAllocatedDeltaMb: round(current.summary.dataMb - baseline.summary.dataMb),
      dataUsedDeltaMb,
      logAllocatedDeltaMb: round(current.summary.logMb - baseline.summary.logMb),
      logUsedDeltaMb: round(current.summary.logUsedMb - baseline.summary.logUsedMb),
      tableUsedDeltaMb,
      unattributedDataUsedDeltaMb,
      attributionPercent,
      tableCountDelta: current.summary.tableCount - baseline.summary.tableCount,
      addedTableCount,
      removedTableCount,
      schemaChangedTableCount: allSchemaDeltas.length
    },
    fileDeltas,
    tableDeltas: returned,
    totalTableDifferenceCount: sortedTableDeltas.length,
    returnedTableDifferenceCount: returned.length,
    omittedTableDifferenceCount: Math.max(0, sortedTableDeltas.length - returned.length),
    schemaDeltas: returnedSchema,
    totalSchemaDifferenceCount: allSchemaDeltas.length,
    returnedSchemaDifferenceCount: returnedSchema.length,
    omittedSchemaDifferenceCount: Math.max(0, allSchemaDeltas.length - returnedSchema.length),
    limitations
  };
}
