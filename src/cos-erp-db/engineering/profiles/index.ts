import { detectLinkqEngineeringProfile, LINKQ_ENGINEERING_PROFILE } from './linkq.js';

export interface EngineeringProfile {
  id: string;
  title: string;
  principles: readonly string[];
  analogueTarget: { readonly min: number; readonly max: number };
  preferredEvidenceOrder?: readonly string[];
  qualityDimensions?: readonly string[];
}

export const GENERIC_ENGINEERING_PROFILE = {
  id: 'generic',
  title: 'Project-Native Engineering',
  principles: [
    'Learn the project identity from verified local evidence before changing code.',
    'Separate intentional conventions from accidental legacy debt.',
    'Prefer the smallest compatible change that satisfies correctness and maintainability.',
    'Do not claim production-scale quality without appropriate evidence.'
  ],
  analogueTarget: { min: 3, max: 7 }
} as const;

export function canonicalEngineeringProfileId(profileInput: string | undefined): string {
  const profile = profileInput?.trim().toLocaleLowerCase('en-US') || 'generic';
  return profile === 'linkq' ? 'linkq' : 'generic';
}

export function engineeringProfile(profileInput: string | undefined): EngineeringProfile {
  const profile = canonicalEngineeringProfileId(profileInput);
  if (profile === 'linkq') return LINKQ_ENGINEERING_PROFILE;
  return GENERIC_ENGINEERING_PROFILE;
}

export async function detectRegisteredEngineeringProfile(workspaceReal: string): Promise<string | null> {
  if (await detectLinkqEngineeringProfile(workspaceReal)) return 'linkq';
  return null;
}
