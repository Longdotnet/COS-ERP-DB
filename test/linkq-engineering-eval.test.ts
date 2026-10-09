import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LINKQ_ENGINEERING_EVAL_CASES } from '../src/cos-erp-db/engineering/evals/linkq.js';
import { LINKQ_ENGINEERING_PROFILE } from '../src/cos-erp-db/engineering/profiles/linkq.js';

it('keeps a stable LINKQ evaluation corpus without pretending a model baseline was measured', () => {
  expect(LINKQ_ENGINEERING_EVAL_CASES.length).toBeGreaterThanOrEqual(6);
  expect(new Set(LINKQ_ENGINEERING_EVAL_CASES.map(item => item.id)).size).toBe(LINKQ_ENGINEERING_EVAL_CASES.length);
  for (const testCase of LINKQ_ENGINEERING_EVAL_CASES) {
    expect(testCase.expectedDimensions.length).toBeGreaterThan(0);
    expect(testCase.mustAvoid.length).toBeGreaterThan(0);
  }
  expect(LINKQ_ENGINEERING_PROFILE.analogueTarget).toEqual({ min: 3, max: 7 });
  expect(LINKQ_ENGINEERING_PROFILE.principles.join(' ')).toContain('historical implementation mistakes');
  const skill = readFileSync(new URL('../src/cos-erp-db/engineering/skills/linkq-engineering/SKILL.md', import.meta.url), 'utf8');
  expect(skill).toContain('3–7 relevant analogues');
  expect(skill).toContain('legacy_debt');
  expect(skill).toContain('must not be called proven scalable');
});
