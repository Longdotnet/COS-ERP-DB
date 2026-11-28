import { z } from 'zod';
import type { DatabaseActionInput, DatabaseActionOutput, DatabaseObjectDetailsOutput } from '../../main/database/service.js';

type Execute = (input: DatabaseActionInput, options?: { signal?: AbortSignal }) => Promise<DatabaseActionOutput>;
const sqlName = z.string().trim().min(3).max(257).regex(/^[\p{L}\p{N}_$#]+\.[\p{L}\p{N}_$#]+$/u);
const connection = z.string().trim().min(1).max(64);
export const migrationPreflightSchema = z.object({
  sourceConnection: connection, targetConnection: connection,
  tables: z.array(z.object({ source: sqlName, target: sqlName }).strict()).min(1).max(12)
}).strict().superRefine((input,ctx)=>{
  if(input.sourceConnection.toLowerCase()===input.targetConnection.toLowerCase()) ctx.addIssue({code:'custom',path:['targetConnection'],message:'Choose different connections.'});
  for(const side of ['source','target'] as const) if(new Set(input.tables.map(t=>t[side].toLowerCase())).size!==input.tables.length) ctx.addIssue({code:'custom',path:['tables'],message:'Each source and target table must be unique.'});
});

type Row = Record<string,unknown>;
const literal = (s:string)=>"N'"+s.replace(/'/g,"''")+"'";
const lower = (s:string)=>s.toLowerCase();
const objectName=(r:Row)=>String(r.Schema)+'.'+String(r.Name);
const pk = (r:DatabaseObjectDetailsOutput)=>r.indexes?.find(i=>i.primaryKey)?.columns.filter(c=>!c.included).sort((a,b)=>a.ordinal-b.ordinal).map(c=>c.name)??[];

export async function migrationPreflight(input:z.infer<typeof migrationPreflightSchema>, execute:Execute, signal?:AbortSignal) {
  async function queryCatalog(connection:string,names:string[]) {
    const condition=names.map(n=>{
      const [schema,table]=n.split('.');
      return '(s.name='+literal(schema!)+' AND t.name='+literal(table!)+')';
    }).join(' OR ');
    const r=await execute({ action:'query',connection,sql:`SELECT t.object_id AS ObjectId,s.name AS [Schema],t.name AS Name,
      SUM(CONVERT(bigint,p.rows)) AS ApproxRows FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
      LEFT JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id IN (0,1)
      WHERE ${condition} GROUP BY t.object_id,s.name,t.name ORDER BY s.name,t.name`},{signal});
    if(r.action!=='query') throw new Error('Unexpected migration catalog response');
    return r;
  }
  const source=await queryCatalog(input.sourceConnection,input.tables.map(t=>t.source));
  const target=await queryCatalog(input.targetConnection,input.tables.map(t=>t.target));
  if(source.connection===target.connection && source.database===target.database) throw new Error('Migration resolved to the same database identity.');
  const tables=[];
  const allTargetFks:Array<{table:string;parent:string;constraint:string}>=[];
  const resolvedTargets:string[]=[];
  const targetNames=new Set(input.tables.map(t=>lower(t.target)));
  let incomplete=source.truncated||target.truncated;
  async function details(catalog:typeof source, object:Row, section:'columns'|'keys_indexes') {
    const id=object.ObjectId;
    if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0) throw new Error('Invalid catalog object ID');
    const r=await execute({action:'object_details',connection:catalog.connection,objectId:id,section},{signal});
    if(r.action!=='object_details'||r.connection!==catalog.connection||r.database!==catalog.database||r.schema!==object.Schema||r.name!==object.Name||r.type!=='table') throw new Error('Table identity changed during migration preflight.');
    return r;
  }
  for(const pair of input.tables) {
    signal?.throwIfAborted();
    const left=source.rows.filter(r=>lower(objectName(r))===lower(pair.source));
    const right=target.rows.filter(r=>lower(objectName(r))===lower(pair.target));
    if(left.length!==1||right.length!==1) {
      incomplete=true; tables.push({...pair,status:'table-not-resolved',sourceMatches:left.length,targetMatches:right.length}); continue;
    }
    const a=await details(source,left[0]!,'columns'), b=await details(target,right[0]!,'columns');
    const ak=await details(source,left[0]!,'keys_indexes'), bk=await details(target,right[0]!,'keys_indexes');
    const partial=Boolean(a.truncated||b.truncated||ak.truncated||bk.truncated||!a.columns||!b.columns||!ak.indexes||!bk.indexes||!bk.foreignKeys);
    incomplete||=partial;
    const sourceColumns=new Map(a.columns?.map(c=>[lower(c.name),c])??[]);
    const targetColumns=new Map(b.columns?.map(c=>[lower(c.name),c])??[]);
    const findings:Array<{column:string;issue:string;source?:string;target?:string}>=[];
    for(const col of b.columns??[]) {
      if(col.computed||col.identity||/^(?:timestamp|rowversion)$/i.test(col.type)) continue;
      const old=sourceColumns.get(lower(col.name));
      if(!old) {
        if(!col.nullable&&col.defaultDefinition===null) findings.push({column:col.name,issue:'required-target-column-needs-mapping'});
      } else {
        if(old.type!==col.type) findings.push({column:col.name,issue:'type-differs-review-conversion',source:old.type,target:col.type});
        if(old.nullable&&!col.nullable) findings.push({column:col.name,issue:'source-allows-null-target-does-not'});
      }
    }
    for(const col of a.columns??[]) if(!targetColumns.has(lower(col.name))) findings.push({column:col.name,issue:'source-column-not-in-target'});
    const targetKey=pk(bk),sourceKey=pk(ak);
    const keyShapeMatches=sourceKey.length && targetKey.length
      ? JSON.stringify(sourceKey.map(lower))===JSON.stringify(targetKey.map(lower)) : null;
    const fks=(bk.foreignKeys??[]).map(f=>({table:pair.target,parent:f.referencedSchema+'.'+f.referencedTable,constraint:f.name}));
    allTargetFks.push(...fks);
    if(!partial) resolvedTargets.push(pair.target);
    tables.push({...pair,status:partial?'incomplete':findings.length||keyShapeMatches!==true?'mapping-review':'no-observed-column-mismatch',
      sourceApproxRows:left[0]!.ApproxRows,targetApproxRows:right[0]!.ApproxRows,
      sourceColumns:a.columns?.length??null,targetColumns:b.columns?.length??null,sourceKey,targetKey,
      keyShapeMatches,
      findings:findings.slice(0,80), findingsTruncated:findings.length>80,
      targetForeignKeys:fks.map(f=>({parent:f.parent,constraint:f.constraint,inSelectedScope:targetNames.has(lower(f.parent))}))
    });
    incomplete||=findings.length>80;
  }
  // Parent-first candidate order only for declared target foreign keys; do not guess
  // logical dependencies that LinkQ enforces in stored procedures or application code.
  const pending=new Set(resolvedTargets);
  const unresolved=input.tables.map(t=>t.target).filter(t=>!resolvedTargets.includes(t));
  const ordered:string[]=[];
  const edges=allTargetFks.filter(f=>targetNames.has(lower(f.parent)));
  while(pending.size) {
    const ready=[...pending].filter(t=>!edges.some(f=>lower(f.table)===lower(t)&&[...pending,...unresolved].some(p=>lower(p)===lower(f.parent))));
    if(!ready.length) break;
    for(const t of ready) {ordered.push(t);pending.delete(t);}
  }
  return {source:{connection:source.connection,database:source.database},target:{connection:target.connection,database:target.database},
    status:incomplete?'incomplete':'review-required',tables,
    order:{parentFirstCandidates:ordered,blockedByCycleOrUnresolvedParent:[...pending],unresolvedOrIncompleteTables:unresolved,externalParents:allTargetFks.filter(f=>!targetNames.has(lower(f.parent)))},
    limitations:['Same-name mapping candidates only, no inferred renames or transformations.', 'Approximate unfiltered table row counts are catalog observations; no row-level conflict or checksum verification.', 'Declared foreign keys only; ordering is a candidate, not an executable migration plan. No SQL writes or data transfers.']
  };
}
