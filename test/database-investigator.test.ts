import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SqlServerConnection, SqlServerQueryResult } from '../src/main/database/sqlserver.js';
import {
  compareSqlServerSchemas,
  decodeIncidentReasonMask,
  profileSqlServerColumn,
  readSqlServerDeadlocks,
  readSqlServerDiagnosticHistory,
  readSqlServerFieldConsumers,
  readSqlServerJobs,
  readSqlServerLivePerformance,
  readSqlServerQueryStore,
  searchSqlServerColumns
} from '../src/cos-erp-db/investigation/sqlserver-investigator.js';
import { scanSourceTraceRoot } from '../src/cos-erp-db/investigation/source-trace.js';

const connection: SqlServerConnection = {
  server: 'localhost',
  database: 'L80LINKQ.TEST',
  authentication: { type: 'sql', user: 'test', password: 'secret' }
};

function result(rows: Record<string, unknown>[], truncated = false): SqlServerQueryResult {
  return { columns: [], rows, rowCount: rows.length, elapsedMs: 1, truncated };
}

function columnRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_id: 42,
    schema_name: 'dbo',
    table_name: 'L09TDDMUNGVIEN',
    column_id: 1,
    column_name: 'Ma_UvTd',
    type_name: 'varchar',
    max_length: 20,
    precision: 0,
    scale: 0,
    is_nullable: false,
    is_identity: false,
    is_computed: false,
    is_primary_key: true,
    is_indexed: true,
    ...overrides
  };
}

describe('database investigator SQL Server checks', () => {
  it('finds matching columns with useful type and key metadata', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, _sql: string, _options?: { parameters?: Readonly<Record<string, string | number | boolean | null>> }) => result([
      columnRow(),
      columnRow({ object_id: 43, table_name: 'L09TDKETQUA', column_id: 4, is_primary_key: false })
    ]));

    const found = await searchSqlServerColumns('linkq-test', connection, 'Ma_UvTd', query);

    expect(found.matches).toHaveLength(2);
    expect(found.matches[0]).toMatchObject({
      schema: 'dbo', table: 'L09TDDMUNGVIEN', column: 'Ma_UvTd', type: 'varchar(20)', primaryKey: true, indexed: true
    });
    expect(query.mock.calls[0]?.[2]?.parameters).toMatchObject({ exact: 'Ma_UvTd', pattern: '%Ma~_UvTd%' });
  });

  it('profiles a bounded sample instead of scanning the entire customer table', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string) => {
      if (sql.includes('WHERE t.object_id=@object_id')) return result([columnRow()]);
      if (sql.includes('GROUP BY')) return result([
        { value: 'UV001', value_count: 14 },
        { value: 'UV002', value_count: 8 }
      ]);
      if (sql.includes('COUNT_BIG(*) AS sampled_rows')) return result([{
        sampled_rows: 10000,
        null_rows: 0,
        blank_rows: 3,
        distinct_values: 420,
        min_value: 'UV001',
        max_value: 'UV999',
        max_data_length_bytes: 10
      }]);
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const profile = await profileSqlServerColumn('linkq-test', connection, 42, 'Ma_UvTd', query);

    expect(profile).toMatchObject({ sampledRows: 10000, nullRows: 0, blankRows: 3, distinctValues: 420, maxDataLengthBytes: 10 });
    expect(profile.examples[0]).toEqual({ value: 'UV001', count: 14 });
    expect(profile.limitations.join(' ')).toMatch(/10,000 rows/i);
    expect(query.mock.calls.some(call => call[1].includes('TOP (10000)'))).toBe(true);
  });

  it('labels field-consumer evidence by confidence instead of claiming every text match is proven', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string) => {
      if (sql.includes('WHERE t.object_id=@object_id')) return result([columnRow()]);
      return result([
        { object_id: 100, schema_name: 'dbo', object_name: 'Sp_LoadUngVien', type_desc: 'SQL_STORED_PROCEDURE', references_table: true, mentions_column: true },
        { object_id: 101, schema_name: 'dbo', object_name: 'Sp_SearchAny', type_desc: 'SQL_STORED_PROCEDURE', references_table: false, mentions_column: true }
      ]);
    });

    const consumers = await readSqlServerFieldConsumers('linkq-test', connection, 42, 'Ma_UvTd', query);

    expect(consumers.consumers.map(item => item.confidence)).toEqual(['high', 'medium']);
    expect(consumers.limitations.join(' ')).toMatch(/dynamic SQL|application code/i);
  });

  it('degrades live performance checks cleanly when DMV permissions are unavailable', async () => {
    const query = vi.fn(async () => { throw new Error('VIEW SERVER STATE permission denied'); });

    const capture = await readSqlServerLivePerformance('linkq-test', connection, query);

    expect(capture.requests).toEqual([]);
    expect(capture.hotspots).toEqual([]);
    expect(capture.incidentSessions).toEqual([]);
    expect(capture.limitations).toHaveLength(3);
    expect(capture.limitations.join(' ')).toMatch(/VIEW SERVER STATE|unavailable/i);
  });

  it('reconstructs the full blocking chain and includes a sleeping root blocker without following special negative blocker ids', async () => {
    const oldTransaction = new Date(Date.now() - 120_000).toISOString();
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string) => {
      if (sql.includes('FROM sys.dm_exec_requests AS r')) return result([
        {
          session_id: 71, status: 'suspended', session_status: 'running', command: 'SELECT', database_name: 'L80LINKQ.TEST',
          login_name: 'erp', host_name: 'PC-01', program_name: 'LinkQ ERP', total_elapsed_time: 20_000, cpu_time: 200,
          logical_reads: 400, writes: 0, wait_type: 'LCK_M_S', last_wait_type: 'LCK_M_S', wait_time: 15_000,
          wait_resource: 'KEY: 7:1', blocking_session_id: 88, open_transaction_count: 0,
          query_hash: '0x1111111111111111', query_plan_hash: '0xAAAAAAAAAAAAAAAA', sql_text: 'SELECT * FROM dbo.Candidate'
        },
        {
          session_id: 88, status: 'suspended', session_status: 'running', command: 'UPDATE', database_name: 'L80LINKQ.TEST',
          login_name: 'erp', host_name: 'PC-02', program_name: 'LinkQ ERP', total_elapsed_time: 5_000, cpu_time: 100,
          logical_reads: 50, writes: 2, wait_type: 'LCK_M_X', last_wait_type: 'LCK_M_X', wait_time: 500,
          wait_resource: 'KEY: 7:2', blocking_session_id: 99, open_transaction_count: 1,
          query_hash: '0x2222222222222222', query_plan_hash: '0xBBBBBBBBBBBBBBBB', sql_text: 'UPDATE dbo.Candidate SET Name=N\'B\''
        },
        {
          session_id: 55, status: 'suspended', session_status: 'running', command: 'SELECT', database_name: 'L80LINKQ.TEST',
          login_name: 'erp', host_name: 'PC-03', program_name: 'LinkQ ERP', total_elapsed_time: 16_000, cpu_time: 10,
          logical_reads: 5, writes: 0, wait_type: 'LCK_M_S', last_wait_type: 'LCK_M_S', wait_time: 12_000,
          wait_resource: 'OBJECT: 7:42', blocking_session_id: -2, open_transaction_count: 0,
          query_hash: null, query_plan_hash: null, sql_text: 'SELECT 1'
        }
      ]);
      if (sql.includes('WITH transaction_state AS')) return result([
        { session_id: 71, session_status: 'running', login_name: 'erp', host_name: 'PC-01', program_name: 'LinkQ ERP', open_transaction_count: 0, transaction_begin_time: null, database_name: 'L80LINKQ.TEST', sql_text: 'SELECT * FROM dbo.Candidate' },
        { session_id: 88, session_status: 'running', login_name: 'erp', host_name: 'PC-02', program_name: 'LinkQ ERP', open_transaction_count: 1, transaction_begin_time: new Date(Date.now() - 5_000).toISOString(), database_name: 'L80LINKQ.TEST', sql_text: 'UPDATE dbo.Candidate SET Name=N\'B\'' },
        { session_id: 99, session_status: 'sleeping', login_name: 'erp', host_name: 'PC-ROOT', program_name: 'LinkQ ERP', open_transaction_count: 1, transaction_begin_time: oldTransaction, database_name: 'L80LINKQ.TEST', sql_text: 'BEGIN TRAN; UPDATE dbo.Candidate SET Name=N\'A\'' },
        { session_id: 55, session_status: 'running', login_name: 'erp', host_name: 'PC-03', program_name: 'LinkQ ERP', open_transaction_count: 0, transaction_begin_time: null, database_name: 'L80LINKQ.TEST', sql_text: 'SELECT 1' }
      ]);
      if (sql.includes('FROM sys.dm_exec_query_stats AS qs')) return result([]);
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const capture = await readSqlServerLivePerformance('linkq-test', connection, query);
    const sessions = new Map(capture.incidentSessions.map(item => [item.sessionId, item]));

    expect(sessions.get(71)).toMatchObject({ reasonMask: 9, isBlocked: true, isBlocker: false, blockingSessionId: 88, waitResource: 'KEY: 7:1' });
    expect(sessions.get(88)).toMatchObject({ reasonMask: 8, isBlocked: true, isBlocker: true, isRootBlocker: false, blockingSessionId: 99 });
    expect(sessions.get(99)).toMatchObject({ reasonMask: 12, isBlocked: false, isBlocker: true, isRootBlocker: true, isSleepingTransaction: true, host: 'PC-ROOT' });
    expect(sessions.get(99)?.transactionAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(sessions.get(99)?.sql).toContain('BEGIN TRAN');
    expect(sessions.get(55)).toMatchObject({ reasonMask: 1, blockingSessionId: -2, isBlocked: true });
    expect(capture.rootBlockerSessionIds).toContain(99);
    expect(decodeIncidentReasonMask(sessions.get(99)!.reasonMask)).toEqual(['long-transaction', 'blocking-chain']);

    const sessionSql = query.mock.calls.map(call => call[1]).find(sql => sql.includes('WITH transaction_state AS'))!;
    expect(sessionSql).toContain('sys.dm_exec_connections');
    expect(sessionSql).toContain('conn.most_recent_sql_handle');
    expect(sessionSql).not.toContain('s.most_recent_sql_handle');
  });

  it('reads bounded LinkQDiagnostics incident history and degrades cleanly when it is unavailable', async () => {
    const query = vi.fn(async () => result([{
      capture_id: 42, captured_at: '2026-09-19T01:00:00.000Z', server_name: 'SQL01', instance_name: 'ERP',
      blocking_count: 1, long_request_count: 0, capture_open_transaction_count: 1,
      session_id: 99, blocking_session_id: 0, database_name: 'L80LINKQ.TEST', login_name: 'erp', host_name: 'PC-ROOT',
      program_name: 'LinkQ ERP', session_status: 'sleeping', request_status: null, command: null, wait_type: null,
      last_wait_type: 'LCK_M_X', wait_time_ms: 0, wait_resource: null, cpu_time_ms: 12, total_elapsed_time_ms: 0,
      logical_reads: 5, writes: 1, open_transaction_count: 1, transaction_begin_time: '2026-09-19T00:58:00.000Z',
      is_blocked: false, is_blocker: true, is_root_blocker: true, is_sleeping_transaction: true, reason_mask: 12,
      sql_text: 'X'.repeat(9_000), running_statement: null, query_hash: '0x1111111111111111', query_plan_hash: null
    }]));

    const history = await readSqlServerDiagnosticHistory('linkq-test', connection, query);

    expect(history.available).toBe(true);
    expect(history.captures[0]).toMatchObject({ captureId: 42, blockingCount: 1, openTransactionCount: 1 });
    expect(history.captures[0]?.sessions[0]).toMatchObject({
      sessionId: 99, isRootBlocker: true, isSleepingTransaction: true, reasonMask: 12,
      reasons: ['long-transaction', 'blocking-chain']
    });
    expect(history.captures[0]?.sessions[0]?.sql).toHaveLength(8_000);

    const unavailable = await readSqlServerDiagnosticHistory('linkq-test', connection, vi.fn(async () => { throw new Error('Invalid object name'); }));
    expect(unavailable.available).toBe(false);
    expect(unavailable.captures).toEqual([]);
    expect(unavailable.limitations.join(' ')).toMatch(/LinkQDiagnostics|unavailable/i);
  });

  it('reports SQL Agent as unavailable instead of failing the whole investigator', async () => {
    const query = vi.fn(async () => { throw new Error('SELECT permission denied on msdb'); });

    const jobs = await readSqlServerJobs('linkq-test', connection, query);

    expect(jobs.available).toBe(false);
    expect(jobs.jobs).toEqual([]);
    expect(jobs.limitations.join(' ')).toMatch(/SQL Agent|msdb/i);
  });

  it('returns exact column and index drift instead of a single changed hash', async () => {
    const baseline: SqlServerConnection = { ...connection, database: 'L80LINKQ.BASELINE' };
    const current: SqlServerConnection = { ...connection, database: 'L80LINKQ.TEST' };
    const query = vi.fn(async (target: SqlServerConnection, sql: string) => {
      const before = target.database === 'L80LINKQ.BASELINE';
      if (sql.includes('FROM sys.tables AS t') && sql.includes('default_constraint')) {
        return result(before ? [
          { schema_name: 'dbo', table_name: 'Candidate', column_name: 'Code', column_id: 1, type_name: 'varchar', max_length: 20, precision: 0, scale: 0, is_nullable: false, is_identity: false, is_computed: false, collation_name: null, default_definition: null, computed_definition: null },
          { schema_name: 'dbo', table_name: 'Candidate', column_name: 'OldField', column_id: 2, type_name: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: true, is_identity: false, is_computed: false, collation_name: null, default_definition: null, computed_definition: null }
        ] : [
          { schema_name: 'dbo', table_name: 'Candidate', column_name: 'Code', column_id: 1, type_name: 'varchar', max_length: 30, precision: 0, scale: 0, is_nullable: false, is_identity: false, is_computed: false, collation_name: null, default_definition: null, computed_definition: null },
          { schema_name: 'dbo', table_name: 'Candidate', column_name: 'NewField', column_id: 2, type_name: 'date', max_length: 3, precision: 10, scale: 0, is_nullable: true, is_identity: false, is_computed: false, collation_name: null, default_definition: null, computed_definition: null }
        ]);
      }
      if (sql.includes('FROM sys.tables AS t') && sql.includes('sys.index_columns')) {
        return result(before ? [
          { schema_name: 'dbo', table_name: 'Candidate', index_name: 'IX_Candidate_Code', type_desc: 'NONCLUSTERED', is_unique: false, is_primary_key: false, is_unique_constraint: false, is_disabled: false, has_filter: false, filter_definition: null, index_column_id: 1, key_ordinal: 1, is_descending_key: false, is_included_column: false, column_name: 'Code' }
        ] : [
          { schema_name: 'dbo', table_name: 'Candidate', index_name: 'IX_Candidate_Code', type_desc: 'NONCLUSTERED', is_unique: true, is_primary_key: false, is_unique_constraint: false, is_disabled: false, has_filter: false, filter_definition: null, index_column_id: 1, key_ordinal: 1, is_descending_key: false, is_included_column: false, column_name: 'Code' }
        ]);
      }
      if (sql.includes('FROM sys.objects AS o') && sql.includes("o.type IN ('P','V')")) {
        return result(before ? [
          { schema_name: 'dbo', object_name: 'Sp_LoadCandidate', type: 'P', definition: 'CREATE PROCEDURE dbo.Sp_LoadCandidate AS\r\nSELECT Code FROM dbo.Candidate;' }
        ] : [
          { schema_name: 'dbo', object_name: 'Sp_LoadCandidate', type: 'P', definition: 'ALTER PROCEDURE dbo.Sp_LoadCandidate AS\nSELECT Code, NewField FROM dbo.Candidate;' },
          { schema_name: 'dbo', object_name: 'V_Candidate', type: 'V', definition: 'CREATE VIEW dbo.V_Candidate AS SELECT Code FROM dbo.Candidate;' }
        ]);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const compared = await compareSqlServerSchemas('baseline', baseline, 'current', current, query);

    expect(compared.summary).toMatchObject({ columnsAdded: 1, columnsRemoved: 1, columnsChanged: 1, indexesChanged: 1, proceduresChanged: 1, viewsAdded: 1 });
    expect(compared.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'column-changed', object: 'dbo.Candidate.Code', baseline: 'varchar(20) NOT NULL', current: 'varchar(30) NOT NULL', confidence: 'high' }),
      expect.objectContaining({ kind: 'column-added', object: 'dbo.Candidate.NewField' }),
      expect.objectContaining({ kind: 'column-removed', object: 'dbo.Candidate.OldField' }),
      expect.objectContaining({ kind: 'index-changed', object: 'dbo.Candidate.IX_Candidate_Code' }),
      expect.objectContaining({ kind: 'procedure-changed', object: 'dbo.Sp_LoadCandidate', confidence: 'high' }),
      expect.objectContaining({ kind: 'view-added', object: 'dbo.V_Candidate', confidence: 'high' })
    ]));
  });

  it('reads bounded Query Store history and exposes plan-count evidence', async () => {
    const query = vi.fn(async (_connection: SqlServerConnection, sql: string, options?: { parameters?: Readonly<Record<string, string | number | boolean | null>> }) => {
      if (sql.includes('database_query_store_options')) return result([{
        actual_state_desc: 'READ_WRITE', desired_state_desc: 'READ_WRITE', readonly_reason: 0,
        current_storage_size_mb: 125, max_storage_size_mb: 1000
      }]);
      if (sql.includes('sys.query_store_runtime_stats')) {
        expect(options?.parameters).toMatchObject({ hours: 6 });
        return result([{
          query_id: 18, plan_id: 3, execution_count: 22, avg_duration_ms: 1580.5,
          avg_cpu_ms: 240.25, avg_logical_reads: 9001, last_execution_time: '2026-09-17T07:30:00.000Z',
          sql_text: 'SELECT * FROM dbo.L09TDDMUNGVIEN WHERE Ma_UvTd=@P1', plan_count: 2
        }]);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const history = await readSqlServerQueryStore('linkq-test', connection, { hours: 6, sort: 'duration' }, query);

    expect(history).toMatchObject({ available: true, actualState: 'READ_WRITE', hours: 6, currentStorageMb: 125 });
    expect(history.queries[0]).toMatchObject({ queryId: 18, planId: 3, executionCount: 22, avgDurationMs: 1580.5, planCount: 2 });
  });

  it('parses victim/session/source evidence from system_health deadlock XML', async () => {
    const xml = '<deadlock><victim-list><victimProcess id="process1" /></victim-list><process-list>' +
      '<process id="process1" spid="71" hostname="PC-KETOAN" loginname="erp" clientapp="LinkQ ERP" currentdbname="L80LINKQ.TEST" waitresource="KEY: 7:1" lockMode="X"><inputbuf>UPDATE dbo.L09TDDMUNGVIEN SET Ten_UvTd=N\'A\'</inputbuf></process>' +
      '<process id="process2" spid="88" hostname="PC-HRM" loginname="erp" clientapp="LinkQ ERP" currentdbname="L80LINKQ.TEST" waitresource="KEY: 7:2" lockMode="S"><inputbuf>SELECT * FROM dbo.L09TDDMUNGVIEN</inputbuf></process>' +
      '</process-list><resource-list><keylock objectname="L80LINKQ.TEST.dbo.L09TDDMUNGVIEN" indexname="PK_UngVien" /></resource-list></deadlock>';
    const query = vi.fn(async () => result([{ event_time: '2026-09-17T07:31:00.000Z', deadlock_xml: xml }]));

    const deadlocks = await readSqlServerDeadlocks('linkq-test', connection, query);

    expect(deadlocks.available).toBe(true);
    expect(deadlocks.events[0]?.victimProcessId).toBe('process1');
    expect(deadlocks.events[0]?.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 71, victim: true, host: 'PC-KETOAN', application: 'LinkQ ERP' }),
      expect.objectContaining({ sessionId: 88, victim: false, host: 'PC-HRM' })
    ]));
    expect(deadlocks.events[0]?.objects).toContain('L80LINKQ.TEST.dbo.L09TDDMUNGVIEN');
  });

  it('traces an ERP field and SQL consumer into C#/WinForms source without scanning build folders', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-db-trace-'));
    try {
      await mkdir(path.join(root, 'Recruitment'), { recursive: true });
      await mkdir(path.join(root, 'bin'), { recursive: true });
      await writeFile(path.join(root, 'Recruitment', 'frmUngVien.cs'), [
        'gridMaUv.DataPropertyName = "Ma_UvTd";',
        'command.CommandText = "Sp_LoadUngVien";',
        'var row = table.Rows.Find("L09TDDMUNGVIEN");'
      ].join('\n'));
      await writeFile(path.join(root, 'bin', 'Generated.cs'), 'var x = "Ma_UvTd";');

      const traced = await scanSourceTraceRoot(root, '/src-net10-1.0.0', {
        field: 'Ma_UvTd', table: 'L09TDDMUNGVIEN', consumers: ['Sp_LoadUngVien']
      });

      expect(traced.searchedFiles).toBe(1);
      expect(traced.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'winforms-binding', line: 1, matchedTerm: 'Ma_UvTd', confidence: 'high' }),
        expect.objectContaining({ kind: 'sql-call', line: 2, matchedTerm: 'Sp_LoadUngVien', confidence: 'high' }),
        expect.objectContaining({ kind: 'table-reference', line: 3, matchedTerm: 'L09TDDMUNGVIEN' })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
