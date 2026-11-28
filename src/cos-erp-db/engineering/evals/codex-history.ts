import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const idSchema = z.string().uuid();
export const codexHistorySchema = z.object({ sessionIds: z.array(idSchema).min(1).max(12) }).strict();
const MAX_FILES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;
type Counter = Record<string, number>;
const count = (map: Counter, key: string) => { map[key] = (map[key] ?? 0) + 1; };

// Analyze response items only. Do not return conversation text, tool arguments,
// hidden reasoning, or credentials. JS call-site counts are lexical estimates.
export async function scanCodexRecording(file: string, sessionId: string, signal?: AbortSignal) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) return { sessionId, status: 'file-too-large-or-unavailable' as const };
  const stream = createReadStream(file,{ start:0, end:Math.max(0,stat.size-1), encoding:'utf8' });
  const reader = createInterface({ input:stream, crlfDelay:Infinity });
  const abort = () => stream.destroy(new Error('Codex history scan cancelled.'));
  signal?.addEventListener('abort',abort,{once:true});
  let turns=0, completed=0, calls=0, databaseSites=0, malformed=0;
  const actions: Counter = {};
  const dbTurns = new Set<number>();
  const dbCallIds = new Set<string>();
  const errorMarkers: Counter = {};
  try {
    signal?.throwIfAborted();
    for await(const line of reader) {
      signal?.throwIfAborted();
      if(line.length > 8 * 1024 * 1024) { malformed++; continue; }
      let row: { type?:string; payload?: Record<string,unknown> };
      try { row=JSON.parse(line); } catch { malformed++; continue; }
      const p=row.payload;
      if(!p) continue;
      if(row.type==='event_msg' && p.type==='task_started') turns++;
      if(row.type==='event_msg' && p.type==='task_complete') completed++;
      if(row.type!=='response_item') continue;
      if(p.type==='custom_tool_call' || p.type==='function_call') {
        calls++;
        let sites: string[] = [];
        if(typeof p.name==='string' && /^(?:mcp__)?(?:cos_erp_db_core__database|codex_apps__cos_erp_db_core_database)$/i.test(p.name)) {
          sites=[typeof p.arguments==='string'?p.arguments:typeof p.input==='string'?p.input:''];
        } else if(p.type==='custom_tool_call' && p.name==='exec' && typeof p.input==='string') {
          const matches=[...p.input.matchAll(/(?:tools\.)?mcp__(?:cos_erp_db_core__database|codex_apps__cos_erp_db_core_database)\s*\(/gi)];
          sites=matches.map((m,i)=>String(p.input).slice(m.index,matches[i+1]?.index));
        }
        if(sites.length) {
          databaseSites+=sites.length; dbTurns.add(turns);
          if(typeof p.call_id==='string') dbCallIds.add(p.call_id);
          for(const site of sites) {
            const a=site.match(/["']?action["']?\s*:\s*["']([a-z_]{1,40})["']/i)?.[1]?.toLowerCase();
            // Only known action labels are returned, never arbitrary extracted input.
            count(actions,a && /^(query|list_connections|search_objects|object_details|business_trace|business_graph|business_compare|result_compare|object_verify|migration_audit|migration_preflight|incident_history|incident_workspace|schema_compare|deployment_compare|live_performance|column_search|column_profile|query_store|source_trace|data_timeline|field_consumers|jobs|test|workspace_context)$/.test(a)?a:'other-or-dynamic');
          }
        }
      } else if((p.type==='custom_tool_call_output' || p.type==='function_call_output') && typeof p.call_id==='string' && dbCallIds.has(p.call_id)) {
        const output=typeof p.output==='string'?p.output:JSON.stringify(p.output??'');
        if(/permission was denied|Invalid column name|Invalid object name|DATABASE_CONNECTION_REQUIRED|timeout expired/i.test(output)) count(errorMarkers,'recognized-db-error-marker');
      }
    }
  } finally { signal?.removeEventListener('abort',abort); reader.close(); stream.destroy(); }
  const after=await fs.stat(file);
  return { sessionId, status:'observed' as const, bytes:stat.size, turnsStarted:turns, turnsCompleted:completed,
    recordedOuterCalls:calls, databaseCallSites:databaseSites, databaseTurnGroups:dbTurns.size, actions, errorMarkers, skippedRecords:malformed,
    fileChangedDuringScan:after.size!==stat.size||after.mtimeMs!==stat.mtimeMs };
}

export async function collectCodexHistory(input: z.infer<typeof codexHistorySchema>, signal?: AbortSignal) {
  const root=path.join(homedir(),'.codex','sessions');
  const canonical=await fs.realpath(root);
  const requested=new Set(input.sessionIds.map(s=>s.toLowerCase()));
  const files=new Map<string,string[]>();
  let visited=0, clipped=false;
  async function walk(folder:string,depth:number):Promise<void> {
    if(depth>5) { clipped=true; return; }
    for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
      signal?.throwIfAborted();
      if(++visited>MAX_FILES) { clipped=true; return; }
      // Never follow symlinks or junctions outside the selected Codex history.
      if(entry.isSymbolicLink()) continue;
      const target=path.join(folder,entry.name);
      if(entry.isDirectory()) { await walk(target,depth+1); if(visited>MAX_FILES) return; }
      else if(entry.isFile()) {
        const id=/^rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(entry.name)?.[1]?.toLowerCase();
        if(id && requested.has(id)) {
          const actual=await fs.realpath(target);
          const relative=path.relative(canonical,actual);
          if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)) continue;
          const group=files.get(id)??[]; group.push(actual); files.set(id,group);
        }
      }
    }
  }
  await walk(canonical,0);
  const sessions=[];
  for(const sessionId of requested) {
    const candidates=files.get(sessionId)??[];
    if(candidates.length!==1) { sessions.push({sessionId,status:candidates.length?'ambiguous':'not-found'}); continue; }
    sessions.push(await scanCodexRecording(candidates[0]!,sessionId,signal));
  }
  return { source:'local-codex-sessions',sessions, discoveryClipped:clipped,
    limitations:['Only explicitly selected session IDs, current local sessions directory; archives not scanned.', 'Database call sites inside exec JS are static lexical matches, not confirmed executions; loops and aliases may be missed.', 'No chat content or reasoning returned; no correctness or controlled before/after conclusion.'] };
}
