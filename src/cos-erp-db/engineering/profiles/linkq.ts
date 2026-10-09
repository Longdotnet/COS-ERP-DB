import { promises as fs } from 'node:fs';
import path from 'node:path';

export const LINKQ_ENGINEERING_PROFILE = {
  id: 'linkq',
  title: 'LINKQ Engineering',
  principles: [
    'Preserve LINKQ engineering identity, not historical implementation mistakes.',
    'Prefer analogues from the same runtime family and module before broader repository examples.',
    'Infer conventions from multiple implementations; one existing file is evidence, not a standard.',
    'Classify findings as convention, business rule, legacy debt or engineering improvement before copying them.',
    'Keep deltas minimal and compatible unless evidence shows the existing contract cannot meet correctness or scale needs.',
    'Match project naming, SQL, comments and summaries while avoiding AI-style explanatory noise.',
    'Treat large-data claims as unproven without production-scale or runtime evidence.'
  ],
  analogueTarget: { min: 3, max: 7 },
  preferredEvidenceOrder: [
    'same runtime family and module',
    'same feature family',
    'current project policy and skills',
    'database contract/configuration',
    'broader LINKQ implementation',
    'vendor documentation',
    'general external practice'
  ],
  qualityDimensions: [
    'project-convention',
    'runtime-family-fidelity',
    'minimal-delta',
    'business-correctness',
    'sql-quality',
    'large-data-scale',
    'maintainability',
    'comment-summary-style',
    'evidence-grounding',
    'restraint'
  ]
} as const;

const LINKQ_DETECT_MAX_ENTRIES = 400;
const LINKQ_DETECT_MAX_DEPTH = 3;
const LINKQ_DETECT_IGNORES = new Set(['.git', '.vs', 'bin', 'obj', 'node_modules', 'packages', 'dist', 'out']);

/** Profile-owned detector: keeps LINKQ heuristics out of the generic Engineering engine. */
export async function detectLinkqEngineeringProfile(workspaceReal: string): Promise<boolean> {
  let inspected = 0;
  let hasLinkqSolution = false;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > LINKQ_DETECT_MAX_DEPTH || inspected >= LINKQ_DETECT_MAX_ENTRIES || hasLinkqSolution) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch { return; }

    // Check the current folder before spending the bounded traversal budget in child folders.
    // Large LINKQ roots can otherwise exhaust the budget inside an early directory before the
    // root LinkQ*.sln marker is visited.
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLocaleLowerCase('en-US');
      if ((lower.endsWith('.sln') || lower.endsWith('.slnx')) && /^linkq(?:\d|[._-]|$)/i.test(entry.name)) {
        hasLinkqSolution = true;
        return;
      }
    }

    for (const entry of entries) {
      if (inspected >= LINKQ_DETECT_MAX_ENTRIES || hasLinkqSolution) break;
      inspected += 1;
      if (entry.isDirectory()) {
        if (!LINKQ_DETECT_IGNORES.has(entry.name.toLocaleLowerCase('en-US'))) {
          await walk(path.join(folder, entry.name), depth + 1);
        }
      }
    }
  };
  await walk(workspaceReal, 0);
  return hasLinkqSolution;
}
