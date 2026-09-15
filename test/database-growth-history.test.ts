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
});
