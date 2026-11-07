import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../store.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
test('separate process cannot acquire a held repository lock',async t=>{
 const root=await mkdtemp(join(tmpdir(),'issue-planner-process-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const module=new URL('../store.js',import.meta.url).href
 const child=spawn(process.execPath,['--input-type=module','-e',`import {openStore} from ${JSON.stringify(module)}; const store=await openStore(process.argv[1],'owner/repo'); console.log('ready'); process.stdin.resume(); process.stdin.on('end',async()=>{await store.close();process.exit(0)})`,root],{stdio:['pipe','pipe','pipe']})
 t.after(()=>{if(child.exitCode===null)child.kill()})
 await once(child.stdout,'data');await assert.rejects(openStore(root,'OWNER/REPO'),/lock/i)
 const ended=once(child,'exit');child.stdin.end();const [code]=await ended;assert.equal(code,0)
 const store=await openStore(root,'owner/repo');await store.close()
})
test('lock removal is detected synchronously before another outbound action',async t=>{
 const root=await mkdtemp(join(tmpdir(),'issue-planner-loss-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await openStore(root,'owner/repo');t.after(()=>store.close())
 await rm(store.root+'.lock',{recursive:true})
 assert.throws(()=>store.assertHeld(),/lock/)
})
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
