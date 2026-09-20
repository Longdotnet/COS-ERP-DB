import { describe, expect, it } from 'vitest';
import { extractIncidentCauseCandidates } from '../src/cos-erp-db/investigation/incident-cause.js';

describe('incident SQL cause extraction', () => {
  it('extracts explicit ERP procedure, table and DML column evidence', () => {
    expect(extractIncidentCauseCandidates('EXEC dbo.Sp_SaveUngVien @Ma_UvTd = @P1')).toContainEqual({
      kind: 'procedure',
      schema: 'dbo',
      table: null,
      name: 'Sp_SaveUngVien',
      confidence: 'high',
      evidence: 'EXEC/EXECUTE statement'
    });

    const update = extractIncidentCauseCandidates(
      "UPDATE dbo.L09TDDMUNGVIEN SET Ten_UvTd = @Ten, Ma_UvTd = @Ma WHERE Ma_UvTd = @Old"
    );
    expect(update).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'table', schema: 'dbo', name: 'L09TDDMUNGVIEN', evidence: 'UPDATE target' }),
      expect.objectContaining({ kind: 'column', table: 'L09TDDMUNGVIEN', name: 'Ten_UvTd', evidence: 'UPDATE SET column' }),
      expect.objectContaining({ kind: 'column', table: 'L09TDDMUNGVIEN', name: 'Ma_UvTd', evidence: 'UPDATE SET column' })
    ]));
  });

  it('ignores comments, string literals, temp targets and CTE aliases', () => {
    expect(extractIncidentCauseCandidates("SELECT 'EXEC dbo.NotReal'; -- FROM dbo.CommentOnly\nSELECT 1")).toEqual([]);
    expect(extractIncidentCauseCandidates('UPDATE #Tmp SET Code = 1')).toEqual([]);

    const cte = extractIncidentCauseCandidates(
      'WITH C AS (SELECT Ma_UvTd FROM dbo.L09TDDMUNGVIEN) SELECT * FROM C'
    );
    expect(cte).toContainEqual(expect.objectContaining({ kind: 'table', name: 'L09TDDMUNGVIEN' }));
    expect(cte.some(candidate => candidate.name === 'C')).toBe(false);
  });

  it('does not partially misread cross-database names and can identify a JOIN target', () => {
    expect(extractIncidentCauseCandidates('SELECT * FROM OtherDb.dbo.L09TDDMUNGVIEN')).toEqual([]);
    expect(extractIncidentCauseCandidates('EXEC OtherDb.dbo.Sp_SaveUngVien')).toEqual([]);
    expect(extractIncidentCauseCandidates('SELECT 1 FROM #Tmp t JOIN dbo.L09TDDMUNGVIEN u ON u.Ma_UvTd=t.Ma_UvTd'))
      .toContainEqual(expect.objectContaining({ kind: 'table', schema: 'dbo', name: 'L09TDDMUNGVIEN', evidence: 'JOIN object' }));
  });
});
