import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareQueryResults, verifyDeployedObject } from '../src/cos-erp-db/investigation/result-verification.js';
import { auditMigrationScript } from '../src/cos-erp-db/investigation/migration-audit.js';
import { scanCodexRecording } from '../src/cos-erp-db/engineering/evals/codex-history.js';
import { outsideChangeScope } from '../src/cos-erp-db/engineering/change-scope.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import type { DatabaseActionInput, DatabaseActionOutput, DatabaseQueryOutput } from '../src/main/database/service.js';

const query = (rows: Record<string,unknown>[], truncated=false): DatabaseQueryOutput => ({
  action:'query', connection:'db', database:'TEST', rows, rowCount:rows.length, elapsedMs:1, truncated,
  columns:[{name:'Amount',type:'int',nullable:false}]
});
const input={baseline:{connection:'db',sql:'SELECT Amount FROM old_view'},candidate:{connection:'db',sql:'SELECT Amount FROM new_view'}};

it('compares bags of rows, ignores order, detects duplicate-count mismatches and refuses truncated equality',async()=>{
  const execute=vi.fn().mockResolvedValueOnce(query([{Amount:1},{Amount:2},{Amount:1}])).mockResolvedValueOnce(query([{Amount:2},{Amount:1},{Amount:1}]));
  expect(await compareQueryResults(input,execute)).toMatchObject({status:'same-observed-results',unmatchedRows:{baseline:0,candidate:0}});
  execute.mockResolvedValueOnce(query([{Amount:1},{Amount:1}])).mockResolvedValueOnce(query([{Amount:1}]));
  expect(await compareQueryResults(input,execute)).toMatchObject({status:'different',unmatchedRows:{baseline:1,candidate:0}});
  execute.mockResolvedValueOnce(query([{Amount:1}],true)).mockResolvedValueOnce(query([{Amount:1}]));
  expect(await compareQueryResults(input,execute)).toMatchObject({status:'incomplete',unmatchedRows:null});
  execute.mockClear();
  await expect(compareQueryResults({...input,candidate:{connection:'db',sql:'DELETE FROM t'}},execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it('checks deployed definition by exact schema/object, never reports runtime verification',async()=>{
  const ddl='CREATE VIEW dbo.v AS SELECT 1 AS Amount';
  const execute=vi.fn(async (i:DatabaseActionInput):Promise<DatabaseActionOutput>=>{
    if(i.action==='query')return query([{ObjectId:4,Schema:'dbo',Name:'v',Type:'VIEW'}]);
    if(i.action!=='object_details')throw new Error('unexpected');
    expect(i.objectId).toBe(4);
    return {action:'object_details',connection:'db',database:'TEST',schema:'dbo',name:'v',type:'view',section:'ddl',elapsedMs:1,ddl:{kind:'source',text:ddl,complete:true,truncated:false}};
  });
  const expectedSha256=createHash('sha256').update(ddl).digest('hex');
  expect(await verifyDeployedObject({connection:'db',object:'dbo.v',expectedSha256},execute)).toMatchObject({status:'definition-matches',runtimeVerified:false});
  expect(await verifyDeployedObject({connection:'db',object:'dbo.v',expectedSha256:'0'.repeat(64)},execute)).toMatchObject({status:'definition-differs',runtimeVerified:false});
});
it('audits SQLCMD payload without executing or exposing row values',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cos-migration-'));
  try{
    const sql=Array.from({length:10001},()=> "INSERT INTO #T VALUES ('private-data')").join('\r\n')+'\r\n:r "more.sql"\r\nGO\r\n';
    const file=path.join(dir,'payload.sql');
    await fs.writeFile(file,Buffer.concat([Buffer.from([255,254]),Buffer.from(sql,'utf16le')]));
    const result=await auditMigrationScript('/workspace/payload.sql',[{name:'workspace',path:await validateNewRoot(dir,[])}]);
    expect(result).toMatchObject({insertLeadingLines:10001,sqlcmdIncludeLines:1,goLeadingLines:1});
    expect(result.findings.map(f=>f.code)).toContain('MANY_INSERT_LINES');
    expect(JSON.stringify(result)).not.toContain('private-data');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
it('reads selected Codex journal call sites without exporting messages, arguments or reasoning',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cos-codex-history-'));
  try{
    const file=path.join(dir,'recording.jsonl');
    const rows=[
      {type:'event_msg',payload:{type:'task_started'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{text:'private-chat'}]}},
      {type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'c1',input:'tools.mcp__cos_erp_db_core__database({action:"query",sql:"private-sql"})'}},
      {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'c1',output:'Invalid column name private-column'}},
      {type:'event_msg',payload:{type:'task_complete'}}
    ];
    await fs.writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n'));
    const result=await scanCodexRecording(file,'fixture');
    expect(result).toMatchObject({turnsStarted:1,turnsCompleted:1,databaseCallSites:1,actions:{query:1},errorMarkers:{'recognized-db-error-marker':1}});
    expect(JSON.stringify(result)).not.toMatch(/private-chat|private-sql|private-column/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
it('rejects sibling module and parent paths from scoped patches',()=>{
  const root=path.resolve('CRM');
  const allowed=path.join(root,'frm.cs');
  const sibling=path.resolve('CRM6.0','frm.cs');
  expect(outsideChangeScope([allowed,sibling,path.dirname(root)],[root])).toEqual([sibling,path.dirname(root)]);
});
