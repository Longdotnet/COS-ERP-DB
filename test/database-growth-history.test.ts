import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initDatabaseGrowthHistory,
  readDatabaseGrowthHistory,
  resetDatabaseGrowthHistoryForTests,
  saveDatabaseGrowthSnapshot
} from '../src/main/database/growth-history.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('cos-erp-db-growth-history-');
  initDatabaseGrowthHistory(dir);
});

afterEach(async () => {
  resetDatabaseGrowthHistoryForTests();
  await removeTempDir(dir);
});

describe('database growth history', () => {
  it('persists bounded local snapshots without database credentials', async () => {
    const snapshot = {
      database: 'ERP',
      capturedAt: '2026-09-15T17:00:00.000Z',
      summary: { totalMb: 1000, dataMb: 800, logMb: 200, dataUsedMb: 700, logUsedMb: 50, logUsedPercent: 25, tableCount: 20 },
      largestTables: [{ objectId: 42, schema: 'dbo', name: 'History', rows: 1000, reservedMb: 300, usedMb: 290, dataMb: 280, indexMb: 10 }]
    };
    const saved = await saveDatabaseGrowthSnapshot('customer-a', snapshot);
    expect(saved.snapshots).toHaveLength(1);
    expect((await readDatabaseGrowthHistory('customer-a')).snapshots[0]).toMatchObject({ database: 'ERP', capturedAt: snapshot.capturedAt });

    await saveDatabaseGrowthSnapshot('customer-a', snapshot);
    expect((await readDatabaseGrowthHistory('customer-a')).snapshots).toHaveLength(1);

    const text = await fs.readFile(path.join(dir, 'database-growth-history.json'), 'utf8');
    expect(text).toContain('customer-a');
    expect(text).not.toMatch(/password|authentication|server/i);
  });

  it('persists V2 full-table captures while keeping legacy V1 snapshots readable', async () => {
    const legacy = {
      database: 'ERP',
      capturedAt: '2025-09-15T17:00:00.000Z',
      summary: { totalMb: 5000, dataMb: 4000, logMb: 1000, dataUsedMb: 3500, logUsedMb: 100, logUsedPercent: 10, tableCount: 2 },
      largestTables: [{ objectId: 1, schema: 'dbo', name: 'History', rows: 100, reservedMb: 300, usedMb: 290, dataMb: 280, indexMb: 10 }]
    };
    await saveDatabaseGrowthSnapshot('customer-a', legacy);

    const current = {
      captureVersion: 2 as const,
      database: 'ERP',
      capturedAt: '2026-09-15T17:00:00.000Z',
      summary: { totalMb: 25000, dataMb: 21000, logMb: 4000, dataUsedMb: 18000, logUsedMb: 500, logUsedPercent: 12.5, tableCount: 3 },
      files: [{ name: 'ERP', type: 'data' as const, sizeMb: 21000, usedMb: 18000, freeMb: 3000, growth: 512, percentGrowth: false }],
      tables: [
        { objectId: 10, schema: 'dbo', name: 'History', rows: 1000, reservedMb: 8000, usedMb: 7800, dataMb: 7000, indexMb: 800 },
        { objectId: 11, schema: 'dbo', name: 'Audit', rows: 500, reservedMb: 4000, usedMb: 3900, dataMb: 3600, indexMb: 300 },
        { objectId: 12, schema: 'dbo', name: 'Master', rows: 50, reservedMb: 50, usedMb: 45, dataMb: 40, indexMb: 5 }
      ],
      tablesTruncated: false,
      limitations: []
    };
    await saveDatabaseGrowthSnapshot('customer-a', current);

    const history = await readDatabaseGrowthHistory('customer-a');
    expect(history.snapshots).toHaveLength(2);
    expect(history.snapshots[0]).toMatchObject({ captureVersion: 2, tablesTruncated: false });
    expect(history.snapshots[0]!.tables).toHaveLength(3);
    expect(history.snapshots[1]!.largestTables).toHaveLength(1);
  });
});
