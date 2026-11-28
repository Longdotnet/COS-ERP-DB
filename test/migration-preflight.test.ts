import { expect, it, vi } from 'vitest';
import { migrationPreflight, migrationPreflightSchema } from '../src/cos-erp-db/investigation/migration-preflight.js';
import type { DatabaseActionInput, DatabaseActionOutput } from '../src/main/database/service.js';

it('checks independently resolved table IDs, required target fields and target FK ordering',async()=>{
  const execute=vi.fn(async (input:DatabaseActionInput):Promise<DatabaseActionOutput>=>{
    if(input.action!=='query'&&input.action!=='object_details')throw new Error('unexpected action');
    const connection=input.connection!, source=connection==='old', database=source?'CRM6':'NOIBO';
    if(input.action==='query') {
      const rows=[{ObjectId:source?11:21,Schema:'dbo',Name:'Child',ApproxRows:'100'},{ObjectId:source?12:22,Schema:'dbo',Name:'Parent',ApproxRows:'10'}];
      return {action:'query',connection,database,columns:[],rows,rowCount:2,truncated:false,elapsedMs:1};
    }
    expect(source?[11,12]:[21,22]).toContain(input.objectId);
    const child=input.objectId%10===1;
    const base={action:'object_details' as const,connection,database,schema:'dbo',name:child?'Child':'Parent',type:'table' as const,section:input.section,elapsedMs:1};
    const col=(name:string,type:string,nullable:boolean)=>({ordinal:1,name,type,nullable,identity:false,computed:false,defaultDefinition:null,computedDefinition:null});
    if(input.section==='columns') return {...base,columns:source?[col('Code','varchar(30)',true)]:[col('Code','varchar(10)',false),...(child?[col('Required','int',false)]:[])]};
    return {...base,indexes:[],foreignKeys:!source&&child?[{name:'FK_Child_Parent',columns:['Code'],referencedSchema:'dbo',referencedTable:'Parent',referencedColumns:['Code'],deleteAction:'NO_ACTION',updateAction:'NO_ACTION'}]:[]};
  });
  const result=await migrationPreflight(migrationPreflightSchema.parse({sourceConnection:'old',targetConnection:'new',tables:[{source:'dbo.Child',target:'dbo.Child'},{source:'dbo.Parent',target:'dbo.Parent'}]}),execute);
  expect(result.order.parentFirstCandidates).toEqual(['dbo.Parent','dbo.Child']);
  expect(result.tables[0]).toMatchObject({sourceApproxRows:'100',status:'mapping-review',findings:expect.arrayContaining([expect.objectContaining({column:'Required',issue:'required-target-column-needs-mapping'}),expect.objectContaining({column:'Code',issue:'type-differs-review-conversion'})])});
  expect(migrationPreflightSchema.safeParse({sourceConnection:'old',targetConnection:'OLD',tables:[{source:'dbo.Child',target:'dbo.Child'}]}).success).toBe(false);
});
