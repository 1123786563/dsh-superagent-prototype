import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../store.js'
test('repository lock excludes a second instance; records survive reopening',async t=>{
 const root=await mkdtemp(join(tmpdir(),'issue-planner-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const a=await openStore(root,'Owner/Repo');t.after(()=>a.close())
 await assert.rejects(openStore(root,'owner/repo'),/lock/i)
 a.data.records.I1={number:1,state:'planned',text:'persisted'};await a.save();await a.close()
 assert.throws(()=>a.assertHeld(),/lock/)
 const b=await openStore(root,'owner/repo');t.after(()=>b.close());assert.equal(b.data.records.I1.text,'persisted')
 await b.close();await writeFile(join(b.root,'records.json'),JSON.stringify({schemaVersion:99,records:{}}))
 await assert.rejects(openStore(root,'owner/repo'),/schema/)
})
