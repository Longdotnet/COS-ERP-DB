import { promises as fs } from 'node:fs';
import type { Root } from '../../shared/types.js';
import { nativePathIdentity, resolvePath } from '../../main/sandbox.js';
import { knowledgeSha256 } from '../knowledge/evidence.js';
import type { EngineeringAuthorizedReference, EngineeringReferenceRole } from './contracts.js';
import { resolveEngineeringProjectIdentity, type ResolvedEngineeringLineage } from './lineage.js';

export interface EngineeringReferenceRequest {
  path: string;
  role: EngineeringReferenceRole;
  scope: string[];
  reason: string;
}

function cleanStrings(values: readonly string[], max: number): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max);
}

export function engineeringReferenceKnowledgeScope(rootIdentity: string): string {
  return 'engineering-reference-' + rootIdentity;
}

export async function resolveEngineeringAuthorizedReferences(
  resolved: ResolvedEngineeringLineage,
  requests: readonly EngineeringReferenceRequest[],
  roots: readonly Root[]
): Promise<EngineeringAuthorizedReference[]> {
  const references: EngineeringAuthorizedReference[] = [];
  const seenRoots = new Set<string>();
  for (const request of requests) {
    const target = await resolvePath(roots, request.path);
    const stat = await fs.stat(target.real);
    if (!stat.isDirectory()) throw new Error('ENGINEERING_REFERENCE_NOT_DIRECTORY: ' + request.path);
    const rootIdentity = knowledgeSha256(nativePathIdentity(target.real));
    if (rootIdentity === resolved.lineage.rootIdentity) {
      throw new Error('ENGINEERING_REFERENCE_IS_CURRENT_PROJECT: ' + request.path);
    }
    if (seenRoots.has(rootIdentity)) throw new Error('ENGINEERING_REFERENCE_DUPLICATE: ' + request.path);
    seenRoots.add(rootIdentity);
    const scope = cleanStrings(request.scope, 32);
    if (!scope.length) throw new Error('ENGINEERING_REFERENCE_SCOPE_REQUIRED: ' + request.path);
    const reason = request.reason.trim();
    if (!reason) throw new Error('ENGINEERING_REFERENCE_REASON_REQUIRED: ' + request.path);
    const identity = await resolveEngineeringProjectIdentity(target.real);
    references.push({
      id: knowledgeSha256(['engineering-reference:v1', rootIdentity, request.role, scope.join('\\0')].join('\\0')),
      role: request.role,
      virtualPath: target.virtual,
      rootIdentity,
      profile: identity.profile,
      runtimeFamily: identity.runtimeFamily,
      scope,
      reason,
      provenance: 'explicit_task_input'
    });
  }
  return references;
}

export async function verifyEngineeringAuthorizedReference(
  reference: EngineeringAuthorizedReference,
  roots: readonly Root[]
): Promise<{ current: true; real: string; virtual: string } | { current: false; reason: string }> {
  try {
    const target = await resolvePath(roots, reference.virtualPath);
    const stat = await fs.stat(target.real);
    if (!stat.isDirectory()) return { current: false, reason: 'reference path is no longer a directory' };
    const currentIdentity = knowledgeSha256(nativePathIdentity(target.real));
    if (currentIdentity !== reference.rootIdentity) {
      return { current: false, reason: 'reference root identity no longer matches the authorized task binding' };
    }
    return { current: true, real: target.real, virtual: target.virtual };
  } catch (error) {
    return {
      current: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
