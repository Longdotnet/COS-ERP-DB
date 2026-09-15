import { describe, expect, it, vi } from 'vitest';
import { readSqlServerObjectDetails } from '../src/main/database/object-details.js';
import type { SqlServerConnection, SqlServerQueryOptions, SqlServerQueryResult } from '../src/main/database/sqlserver.js';

const connection: SqlServerConnection = {
  server: 'db-host',
  database: 'ERP_TEST',
  authentication: { type: 'sql', user: 'reader', password: 'secret' }
};

function result(rows: Record<string, unknown>[], elapsedMs = 1, truncated = false): SqlServerQueryResult {
  return { columns: [], rows, rowCount: rows.length, elapsedMs, truncated };
}

const header = [{ schema_name: 'dbo', object_name: 'L00ZONES', sql_type: 'U ' }];
const columns = [
  { column_id: 1, column_name: 'Zone', type_schema: 'sys', type_name: 'varchar', max_length: 50, precision: 0, scale: 0, is_nullable: false, is_identity: false, is_computed: false, default_definition: null, computed_definition: null, is_persisted: false },
  { column_id: 2, column_name: 'Description', type_schema: 'sys', type_name: 'nvarchar', max_length: 200, precision: 0, scale: 0, is_nullable: true, is_identity: false, is_computed: false, default_definition: "(N'')", computed_definition: null, is_persisted: false }
];

describe('database object details', () => {
  it('returns bounded column metadata with SQL type declarations', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) =>
      sql.includes('FROM sys.objects AS o') ? result(header) : result(columns, 3));
    const details = await readSqlServerObjectDetails(connection, 42, 'columns', {}, query);
    expect(details).toMatchObject({ schema: 'dbo', name: 'L00ZONES', type: 'table', section: 'columns' });
    expect(details.columns).toEqual([
      expect.objectContaining({ name: 'Zone', type: 'varchar(50)', nullable: false }),
      expect.objectContaining({ name: 'Description', type: 'nvarchar(100)', nullable: true, defaultDefinition: "(N'')" })
    ]);
  });

  it('groups indexes and composite foreign keys without flattening their columns', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => {
      if (sql.includes('FROM sys.objects AS o')) return result(header);
      if (sql.includes('FROM sys.indexes AS i')) return result([
        { index_id: 1, index_name: 'PK_Zones', type_desc: 'CLUSTERED', is_unique: true, is_primary_key: true, is_unique_constraint: true, is_disabled: false, key_ordinal: 1, index_column_id: 1, is_descending_key: false, is_included_column: false, column_name: 'Zone' },
        { index_id: 2, index_name: 'IX_Description', type_desc: 'NONCLUSTERED', is_unique: false, is_primary_key: false, is_unique_constraint: false, is_disabled: false, key_ordinal: 1, index_column_id: 1, is_descending_key: false, is_included_column: false, column_name: 'Description' }
      ]);
      return result([
        { fk_id: 10, fk_name: 'FK_ZoneParent', constraint_column_id: 1, parent_column: 'Zone', referenced_schema: 'dbo', referenced_table: 'ParentZone', referenced_column: 'Zone', delete_referential_action_desc: 'NO_ACTION', update_referential_action_desc: 'CASCADE' }
      ]);
    });
    const details = await readSqlServerObjectDetails(connection, 42, 'keys_indexes', {}, query);
    expect(details.indexes).toHaveLength(2);
    expect(details.indexes?.[0]).toMatchObject({ name: 'PK_Zones', primaryKey: true, columns: [{ name: 'Zone', included: false }] });
    expect(details.foreignKeys?.[0]).toMatchObject({ name: 'FK_ZoneParent', columns: ['Zone'], referencedTable: 'ParentZone', updateAction: 'CASCADE' });
  });

  it('labels table DDL as generated and intentionally incomplete', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, _options: SqlServerQueryOptions) => {
      if (sql.includes('FROM sys.objects AS o')) return result(header);
      if (sql.includes('FROM sys.columns AS c')) return result(columns);
      if (sql.includes('FROM sys.indexes AS i')) return result([
        { index_id: 1, index_name: 'PK_Zones', type_desc: 'CLUSTERED', is_unique: true, is_primary_key: true, is_unique_constraint: true, is_disabled: false, key_ordinal: 1, index_column_id: 1, is_descending_key: false, is_included_column: false, column_name: 'Zone' }
      ]);
      return result([]);
    });
    const details = await readSqlServerObjectDetails(connection, 42, 'ddl', {}, query);
    expect(details.ddl?.kind).toBe('generated-table');
    expect(details.ddl?.complete).toBe(false);
    expect(details.ddl?.text).toContain('CREATE TABLE [dbo].[L00ZONES]');
    expect(details.ddl?.text).toContain('PRIMARY KEY CLUSTERED ([Zone] ASC)');
    expect(details.ddl?.note).toMatch(/omits secondary indexes/i);
  });

  it('returns both inbound and outbound dependencies with hard bounds', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, options: SqlServerQueryOptions) => {
      if (sql.includes('FROM sys.objects AS o')) return result([{ schema_name: 'dbo', object_name: 'Sp_Test', sql_type: 'P ' }]);
      if (sql.includes('d.referencing_id = @object_id')) return result([{ server_name: null, database_name: null, schema_name: 'dbo', object_name: 'L00ZONES', sql_type: 'U ' }]);
      expect(sql).toContain('sys.dm_sql_referencing_entities');
      expect(options.parameters).toMatchObject({ entity_name: '[dbo].[Sp_Test]' });
      return result([{ server_name: null, database_name: null, schema_name: 'dbo', object_name: 'Sp_Parent', sql_type: 'P ' }]);
    });
    const details = await readSqlServerObjectDetails(connection, 77, 'dependencies', {}, query);
    expect(details.outboundDependencies?.[0]).toMatchObject({ schema: 'dbo', name: 'L00ZONES', type: 'table' });
    expect(details.inboundDependencies?.[0]).toMatchObject({ schema: 'dbo', name: 'Sp_Parent', type: 'procedure' });
  });
});
