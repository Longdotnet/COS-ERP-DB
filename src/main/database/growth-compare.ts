import type {
  DatabaseGrowthCapture,
  DatabaseGrowthComparisonResult,
  DatabaseGrowthFileDelta,
  DatabaseGrowthFileSummary,
  DatabaseGrowthTableDelta,
  DatabaseGrowthTableSummary
} from '../../shared/database.js';

export const MAX_RETURNED_GROWTH_TABLE_DELTAS = 100;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function tableKey(table: Pick<DatabaseGrowthTableSummary, 'schema' | 'name'>): string {
  return `${table.schema}\u0000${table.name}`;
}

function fileKey(file: Pick<DatabaseGrowthFileSummary, 'type' | 'name'>): string {
  return `${file.type}\u0000${file.name}`;
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

/** Pure comparison: all attribution is computed before the UI-sized table list is truncated. */
export function compareDatabaseGrowthCaptures(
  baselineConnection: string,
  baseline: DatabaseGrowthCapture,
  currentConnection: string,
  current: DatabaseGrowthCapture,
  metadata: { baselineAsOf?: string } = {}
): DatabaseGrowthComparisonResult {
  const beforeTables = new Map(baseline.tables.map(table => [tableKey(table), table]));
  const afterTables = new Map(current.tables.map(table => [tableKey(table), table]));
  const tableKeys = new Set([...beforeTables.keys(), ...afterTables.keys()]);
  const allTableDeltas = [...tableKeys]
    .map(key => tableDelta(beforeTables.get(key), afterTables.get(key)))
    .filter(isTableDifference);

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

  const limitations = [...new Set([
    ...baseline.limitations.map(item => `Baseline: ${item}`),
    ...current.limitations.map(item => `Current: ${item}`),
    ...(baseline.tablesTruncated || current.tablesTruncated
      ? ['Table attribution is incomplete because at least one capture reached the table capture limit.']
      : [])
  ])];

  const returned = sortedTableDeltas.slice(0, MAX_RETURNED_GROWTH_TABLE_DELTAS);
  return {
    baseline: {
      connection: baselineConnection,
      database: baseline.database,
      capturedAt: baseline.capturedAt,
      ...(metadata.baselineAsOf ? { asOf: metadata.baselineAsOf } : {}),
      tablesTruncated: baseline.tablesTruncated
    },
    current: {
      connection: currentConnection,
      database: current.database,
      capturedAt: current.capturedAt,
      tablesTruncated: current.tablesTruncated
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
      tableCountDelta: current.summary.tableCount - baseline.summary.tableCount
    },
    fileDeltas,
    tableDeltas: returned,
    totalTableDifferenceCount: sortedTableDeltas.length,
    returnedTableDifferenceCount: returned.length,
    omittedTableDifferenceCount: Math.max(0, sortedTableDeltas.length - returned.length),
    limitations
  };
}
