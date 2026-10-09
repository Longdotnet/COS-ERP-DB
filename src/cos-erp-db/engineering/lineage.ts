import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { currentCaller } from '../../main/mcp/call-context.js';
import { getProject, projectWorkspace } from '../../main/projects.js';
import { nativePathIdentity } from '../../main/sandbox.js';
import { getSession } from '../../main/session/store.js';
import { currentWorkspace } from '../../main/workspace.js';
import type { EngineeringProjectLineage } from './contracts.js';
import { canonicalEngineeringProfileId, detectRegisteredEngineeringProfile } from './profiles/index.js';

export interface EngineeringLineageOptions {
  profile?: string;
  runtimeFamily?: string | null;
  sourceRevision?: string | null;
}

export interface ResolvedEngineeringLineage {
  lineage: EngineeringProjectLineage;
  workspace: { virtual: string; real: string };
}

export interface EngineeringProjectDefaults {
  profile: string | null;
  runtimeFamily: string | null;
}

const RUNTIME_SCAN_FILE_LIMIT = 80;
const RUNTIME_SCAN_ENTRY_LIMIT = 2_000;
const RUNTIME_SCAN_DEPTH = 4;
const RUNTIME_SCAN_BYTES = 256 * 1024;
const RUNTIME_IGNORES = new Set(['.git', '.vs', 'bin', 'obj', 'node_modules', 'packages', 'dist', 'out']);

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function optional(value: string | null | undefined, max: number): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized.slice(0, max) : null;
}

export async function readEngineeringProjectDefaults(workspaceReal: string): Promise<EngineeringProjectDefaults> {
  const file = path.join(workspaceReal, '.agents', 'engineering.json');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('ENGINEERING_MANIFEST_INVALID: .agents/engineering.json is not a bounded regular file');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    return {
      profile: optional(typeof raw.profile === 'string' ? raw.profile : null, 80),
      runtimeFamily: optional(typeof raw.runtimeFamily === 'string' ? raw.runtimeFamily : null, 120)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: null, runtimeFamily: null };
    if (error instanceof SyntaxError) throw new Error('ENGINEERING_MANIFEST_INVALID: .agents/engineering.json must contain valid JSON');
    throw error;
  }
}

function normalizedRuntime(monikerInput: string): string | null {
  const moniker = monikerInput.trim().toLocaleLowerCase('en-US');
  const modern = /^net(\d+)\.(\d+)(?:[-].*)?$/.exec(moniker);
  if (modern) return `net${modern[1]}`;
  const framework = /^v(\d+)\.(\d+)(?:\.(\d+))?$/.exec(moniker);
  if (framework) return `net${framework[1]}${framework[2]}${framework[3] ?? ''}`;
  if (/^net\d{2,3}$/.test(moniker)) return moniker;
  if (/^netstandard\d+(?:\.\d+)?$/.test(moniker)) return moniker.replace('.', '');
  return null;
}

function runtimeMonikers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/<TargetFramework(?:s)?>\s*([^<]+?)\s*<\/TargetFramework(?:s)?>/gi)) {
    for (const item of (match[1] ?? '').split(';')) if (item.trim()) found.push(item.trim());
  }
  for (const match of text.matchAll(/<TargetFrameworkVersion>\s*([^<]+?)\s*<\/TargetFrameworkVersion>/gi)) {
    if (match[1]?.trim()) found.push(match[1].trim());
  }
  return found;
}

export async function detectEngineeringRuntimeFamily(workspaceReal: string): Promise<string | null> {
  const candidates: string[] = [];
  const runtimes = new Set<string>();
  let scannedEntries = 0;
  const preferred = path.join(workspaceReal, 'Directory.Build.props');
  try {
    if ((await fs.stat(preferred)).isFile()) {
      const stat = await fs.stat(preferred);
      if (stat.size <= RUNTIME_SCAN_BYTES) {
        const preferredRuntimes = new Set(
          runtimeMonikers(await fs.readFile(preferred, 'utf8'))
            .map(normalizedRuntime)
            .filter((value): value is string => Boolean(value))
        );
        if (preferredRuntimes.size === 1) return [...preferredRuntimes][0]!;
        if (preferredRuntimes.size > 1) return 'mixed';
      }
      candidates.push(preferred);
    }
  } catch { /* optional */ }

  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > RUNTIME_SCAN_DEPTH || candidates.length >= RUNTIME_SCAN_FILE_LIMIT || scannedEntries >= RUNTIME_SCAN_ENTRY_LIMIT) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (candidates.length >= RUNTIME_SCAN_FILE_LIMIT || scannedEntries >= RUNTIME_SCAN_ENTRY_LIMIT) break;
      scannedEntries += 1;
      if (entry.isDirectory()) {
        if (!RUNTIME_IGNORES.has(entry.name.toLocaleLowerCase('en-US'))) await walk(path.join(folder, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLocaleLowerCase('en-US');
      if (['.csproj', '.vbproj', '.fsproj', '.props'].includes(extension)) candidates.push(path.join(folder, entry.name));
      if (depth <= 2) {
        const name = entry.name.toLocaleLowerCase('en-US');
        if (name === 'package.json') runtimes.add('node');
        else if (name === 'pyproject.toml' || name === 'requirements.txt' || name === 'pipfile') runtimes.add('python');
        else if (name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts') runtimes.add('java');
        else if (name === 'go.mod') runtimes.add('go');
        else if (name === 'cargo.toml') runtimes.add('rust');
      }
    }
  };
  await walk(workspaceReal, 0);

  for (const file of [...new Set(candidates)]) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > RUNTIME_SCAN_BYTES) continue;
      const text = await fs.readFile(file, 'utf8');
      for (const moniker of runtimeMonikers(text)) {
        const runtime = normalizedRuntime(moniker);
        if (runtime) runtimes.add(runtime);
      }
    } catch { /* one unreadable project file must not break project detection */ }
  }
  if (runtimes.size === 1) return [...runtimes][0]!;
  return runtimes.size > 1 ? 'mixed' : null;
}

export async function resolveEngineeringProjectIdentity(
  workspaceReal: string,
  options: EngineeringLineageOptions = {}
): Promise<{ profile: string; runtimeFamily: string | null }> {
  const defaults = await readEngineeringProjectDefaults(workspaceReal);
  const declaredProfile = optional(options.profile, 80) ?? defaults.profile;
  const detectedProfile = declaredProfile ? null : await detectRegisteredEngineeringProfile(workspaceReal);
  const profile = canonicalEngineeringProfileId(declaredProfile ?? detectedProfile ?? 'generic');
  const runtimeFamily = optional(options.runtimeFamily, 120)
    ?? defaults.runtimeFamily
    ?? await detectEngineeringRuntimeFamily(workspaceReal);
  return { profile, runtimeFamily };
}

export function engineeringKnowledgeScope(lineage: EngineeringProjectLineage): string {
  return `engineering-${lineage.key}`;
}

export function engineeringLineageKey(rootIdentity: string, profile: string, _runtimeFamily: string | null): string {
  return hash([
    'engineering-lineage:v1',
    rootIdentity,
    profile.toLocaleLowerCase('en-US')
  ].join('\0'));
}

export async function resolveEngineeringLineage(options: EngineeringLineageOptions = {}): Promise<ResolvedEngineeringLineage> {
  const caller = currentCaller();
  let projectId: string | null = null;
  let workspace: { virtual: string; real: string } | null = null;

  if (caller.sessionId) {
    const session = await getSession(caller.sessionId);
    if (session?.projectId) {
      const project = await getProject(session.projectId);
      if (!project) throw new Error('ENGINEERING_PROJECT_UNAVAILABLE: the session project no longer exists');
      projectId = project.id;
      workspace = await projectWorkspace(project.id);
    }
  }
  if (!workspace) {
    const current = currentWorkspace();
    if (current) workspace = { virtual: current.virtual, real: current.real };
  }
  if (!workspace) throw new Error('ENGINEERING_PROJECT_REQUIRED: bind the chat to a project or establish its workspace first');

  const identity = await resolveEngineeringProjectIdentity(workspace.real, options);
  const profile = identity.profile;
  const runtimeFamily = identity.runtimeFamily;
  const sourceRevision = optional(options.sourceRevision, 160);
  const rootIdentity = hash(nativePathIdentity(workspace.real));
  const key = engineeringLineageKey(rootIdentity, profile, runtimeFamily);
  return {
    lineage: { key, projectId, rootIdentity, profile, runtimeFamily, sourceRevision },
    workspace
  };
}
