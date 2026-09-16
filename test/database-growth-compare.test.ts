import { describe, expect, it } from 'vitest';
import type { DatabaseGrowthCapture } from '../src/shared/database.js';
import { compareDatabaseGrowthCaptures } from '../src/main/database/growth-compare.js';

function capture(overrides: Partial<DatabaseGrowthCapture> = {}): DatabaseGrowthCapture {
  return {
    captureVersion: 2,
    database: 'ERP',
    capturedAt: '2025-09-16T00:00:00.000Z',
    summary: { totalMb: 5120, dataMb: 4096, logMb: 1024, dataUsedMb: 3800, logUsedMb: 100, logUsedPercent: 9.77, tableCount: 2 },
    files: [
      { name: 'ERP', type: 'data', sizeMb: 4096, usedMb: 3800, freeMb: 296, growth: 128, percentGrowth: false },
      { name: 'ERP_log', type: 'log', sizeMb: 1024, usedMb: null, freeMb: null, growth: 128, percentGrowth: false }
    ],
    tables: [
      { objectId: 1, schema: 'dbo', name: 'History', rows: 1_000_000, reservedMb: 800, usedMb: 750, dataMb: 700, indexMb: 50 },
      { objectId: 2, schema: 'dbo', name: 'Master', rows: 10_000, reservedMb: 100, usedMb: 90, dataMb: 80, indexMb: 10 }
    ],
    tablesTruncated: false,
    tableFingerprints: [
      { schema: 'dbo', name: 'History', columnCount: 5, indexCount: 2, columnHash: '100', indexHash: '200' },
      { schema: 'dbo', name: 'Master', columnCount: 3, indexCount: 1, columnHash: '300', indexHash: '400' }
    ],
    schemaTruncated: false,
    limitations: [],
    ...overrides
  };
}

describe('database growth compare', () => {
  it('separates allocated growth from used growth and attributes table/index changes', () => {
    const baseline = capture();
    const current = capture({
      database: 'ERP_CURRENT',
      capturedAt: '2026-09-16T00:00:00.000Z',
      summary: { totalMb: 25_600, dataMb: 21_504, logMb: 4096, dataUsedMb: 18_600, logUsedMb: 500, logUsedPercent: 12.21, tableCount: 3 },
      files: [
        { name: 'ERP', type: 'data', sizeMb: 21_504, usedMb: 18_600, freeMb: 2904, growth: 512, percentGrowth: false },
        { name: 'ERP_log', type: 'log', sizeMb: 4096, usedMb: null, freeMb: null, growth: 512, percentGrowth: false }
      ],
      tables: [
        { objectId: 90, schema: 'dbo', name: 'History', rows: 40_000_000, reservedMb: 8500, usedMb: 8200, dataMb: 7100, indexMb: 1100 },
        { objectId: 91, schema: 'dbo', name: 'Master', rows: 11_000, reservedMb: 105, usedMb: 95, dataMb: 84, indexMb: 11 },
        { objectId: 92, schema: 'dbo', name: 'Audit', rows: 5_000_000, reservedMb: 4400, usedMb: 4300, dataMb: 4000, indexMb: 300 }
      ]
    });

    const comparison = compareDatabaseGrowthCaptures('backup-2025', baseline, 'prod', current);

    expect(comparison.summary).toMatchObject({
      totalAllocatedDeltaMb: 20_480,
      dataAllocatedDeltaMb: 17_408,
      dataUsedDeltaMb: 14_800,
      logAllocatedDeltaMb: 3072,
      logUsedDeltaMb: 400,
      tableCountDelta: 1
    });
    expect(comparison.tableDeltas[0]).toMatchObject({ schema: 'dbo', name: 'History', usedDeltaMb: 7450, indexDeltaMb: 1050 });
    expect(comparison.tableDeltas.find(row => row.name === 'Audit')).toMatchObject({ state: 'added', usedDeltaMb: 4300 });
    expect(comparison.summary.tableUsedDeltaMb).toBe(11_755);
    expect(comparison.summary.unattributedDataUsedDeltaMb).toBe(3045);
    expect(comparison.summary.attributionPercent).toBeCloseTo(79.43, 2);
    expect(comparison.summary.addedTableCount).toBe(1);
    expect(comparison.summary.removedTableCount).toBe(0);
  });

  it('matches tables by schema/name instead of object id and reports removals', () => {
    const baseline = capture();
    const current = capture({
      tables: [{ objectId: 500, schema: 'dbo', name: 'History', rows: 2_000_000, reservedMb: 900, usedMb: 850, dataMb: 790, indexMb: 60 }],
      summary: { totalMb: 5200, dataMb: 4176, logMb: 1024, dataUsedMb: 3850, logUsedMb: 100, logUsedPercent: 9.77, tableCount: 1 }
    });

    const comparison = compareDatabaseGrowthCaptures('old', baseline, 'new', current);
    expect(comparison.tableDeltas.find(row => row.name === 'History')).toMatchObject({ state: 'matched', baselineObjectId: 1, currentObjectId: 500 });
    expect(comparison.tableDeltas.find(row => row.name === 'Master')).toMatchObject({ state: 'removed', usedDeltaMb: -90 });
    expect(comparison.summary.removedTableCount).toBe(1);
  });

  it('keeps attribution limitations when either side was truncated', () => {
    const comparison = compareDatabaseGrowthCaptures('old', capture({ tablesTruncated: true }), 'new', capture());
    expect(comparison.limitations.join(' ')).toMatch(/attribution is incomplete/i);
  });

  it('detects column and index drift independently of storage and object ids', () => {
    const baseline = capture();
    const current = capture({
      tables: [
        { objectId: 90, schema: 'dbo', name: 'History', rows: 1_000_000, reservedMb: 800, usedMb: 750, dataMb: 700, indexMb: 50 },
        { objectId: 91, schema: 'dbo', name: 'Master', rows: 10_000, reservedMb: 100, usedMb: 90, dataMb: 80, indexMb: 10 }
      ],
      tableFingerprints: [
        { schema: 'dbo', name: 'History', columnCount: 6, indexCount: 3, columnHash: '101', indexHash: '201' },
        { schema: 'dbo', name: 'Master', columnCount: 3, indexCount: 1, columnHash: '300', indexHash: '400' }
      ]
    });

    const comparison = compareDatabaseGrowthCaptures('old', baseline, 'new', current);
    expect(comparison.summary.schemaChangedTableCount).toBe(1);
    expect(comparison.schemaDeltas).toEqual([
      expect.objectContaining({
        schema: 'dbo',
        name: 'History',
        baselineObjectId: 1,
        currentObjectId: 90,
        columnChanged: true,
        indexChanged: true,
        baselineColumnCount: 5,
        currentColumnCount: 6,
        baselineIndexCount: 2,
        currentIndexCount: 3
      })
    ]);
    expect(comparison.tableDeltas).toHaveLength(0);
  });

  it('reports schema drift as incomplete when a source has no complete fingerprint capture', () => {
    const comparison = compareDatabaseGrowthCaptures(
      'old',
      capture({ tableFingerprints: [], schemaTruncated: true }),
      'new',
      capture()
    );
    expect(comparison.schemaDeltas).toEqual([]);
    expect(comparison.limitations.join(' ')).toMatch(/column\/index drift is incomplete/i);
  });
});
