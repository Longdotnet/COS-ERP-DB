export interface LinkqEngineeringEvalCase {
  id: string;
  taskFamily: string;
  runtimeFamily: 'net8' | 'net10' | 'mixed';
  expectedDimensions: string[];
  mustAvoid: string[];
}

/**
 * Stable corpus for before/after agent runs. This file defines the benchmark; it does not
 * invent a model score. A measured baseline is produced only by executing the same cases.
 */
export const LINKQ_ENGINEERING_EVAL_CASES: readonly LinkqEngineeringEvalCase[] = [
  {
    id: 'acb-callback-status',
    taskFamily: 'BankHub ACB callback status flow',
    runtimeFamily: 'net8',
    expectedDimensions: ['project-convention', 'business-correctness', 'minimal-delta', 'evidence-grounding'],
    mustAvoid: ['shared UI learns raw ACB status codes', 'unverified MB/Vietin behavior changes']
  },
  {
    id: 'recruitment-import',
    taskFamily: 'HRM recruitment mailbox import',
    runtimeFamily: 'net10',
    expectedDimensions: ['runtime-family-fidelity', 'business-correctness', 'maintainability', 'comment-summary-style'],
    mustAvoid: ['invented database contracts', 'discarding persisted HR edits']
  },
  {
    id: 'timekeeping-grid',
    taskFamily: 'frmCapNhatCong empty-grid root cause',
    runtimeFamily: 'net10',
    expectedDimensions: ['evidence-grounding', 'project-convention', 'restraint'],
    mustAvoid: ['treating returned rows as proof that grid metadata initialized']
  },
  {
    id: 'voucher-change-tracking',
    taskFamily: 'Voucher SQL Change Tracking auto refresh',
    runtimeFamily: 'net8',
    expectedDimensions: ['sql-quality', 'large-data-scale', 'minimal-delta', 'business-correctness'],
    mustAvoid: ['unbounded polling queries', 'refreshing unrelated voucher types']
  },
  {
    id: 'listview-async-migration',
    taskFamily: 'LinkQ.Lists async and modal migration',
    runtimeFamily: 'net10',
    expectedDimensions: ['runtime-family-fidelity', 'project-convention', 'maintainability', 'restraint'],
    mustAvoid: ['blocking wrappers that fake async', 'solution-wide modernization']
  },
  {
    id: 'sql-large-data',
    taskFamily: 'Production-scale SQL change',
    runtimeFamily: 'mixed',
    expectedDimensions: ['sql-quality', 'large-data-scale', 'evidence-grounding'],
    mustAvoid: ['N+1 database calls', 'claiming scale from test-volume data alone']
  }
] as const;
