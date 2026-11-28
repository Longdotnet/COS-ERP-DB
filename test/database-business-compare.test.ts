import { expect, it, vi } from 'vitest';
import { compareBusinessObject } from '../src/cos-erp-db/investigation/business-compare.js';
import type { DatabaseActionInput, DatabaseActionOutput } from '../src/main/database/service.js';

it('compares the actual tax table across customer DBs using each connection’s own object ID', async () => {
  const execute = vi.fn(async (input: DatabaseActionInput): Promise<DatabaseActionOutput> => {
    if (input.action !== 'query' && input.action !== 'object_details') throw new Error('unexpected action');
    const connection = input.connection!;
    const database = connection === 'r2' ? 'L80LINKQ.R2' : 'L70HUY_HOANG_LAM_HA';
    const objectId = connection === 'r2' ? 189243729 : 869330607;
    if (input.action === 'object_details') {
      expect(input.objectId).toBe(objectId);
      expect(input.section).toBe('columns');
      return { action: 'object_details', connection, database, schema: 'dbo', name: 'L81DMTHUE', type: 'table', section: 'columns', elapsedMs: 1,
        columns: connection === 'r2' ? [] : [{ ordinal: 1, name: 'Type_Id_VAT', type: 'int', nullable: false, identity: false, computed: false, defaultDefinition: null, computedDefinition: null }] };
    }
    const rows = input.sql.includes('FROM sys.objects') ? [{ ObjectId: objectId, Schema: 'dbo', Name: 'L81DMTHUE', Type: 'USER_TABLE' }] : [];
    return { action: 'query', connection, database, columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated: false };
  });
  const result = await compareBusinessObject({ connection: 'lamha', baselineConnection: 'r2', search: 'L81DMTHUE' }, execute);
  expect(result.objects).toMatchObject([{ object: 'dbo.L81DMTHUE', status: 'different', differenceCount: 1, differences: [{ column: 'Type_Id_VAT', baseline: null, current: { type: 'int' } }] }]);
  expect(result.baseline.connection).toBe('r2');
  expect(result.current.connection).toBe('lamha');
});

it('rejects comparing the same connection without querying it', async () => {
  const execute = vi.fn();
  await expect(compareBusinessObject({ connection: 'r2', baselineConnection: 'R2', search: 'L81DMTHUE' }, execute)).rejects.toThrow('different database connections');
  expect(execute).not.toHaveBeenCalled();
});
