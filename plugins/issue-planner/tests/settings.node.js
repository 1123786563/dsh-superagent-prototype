import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { PlannerSettings, settingsValue, settingsHandler } from '../settings.js'
const fixture=()=>{
 const entry={options:{id:'issue-planner',name:'@local/dsh-issue-planner',config:{enabled:false,provider:'keep-provider',model:'keep-model',pollSeconds:300}}}
 const editor={entries:()=>[entry],async edit(target,change){assert.equal(target,entry);entry.options.config=change(structuredClone(entry.options.config))}}
 const settings=new PlannerSettings({editor,entryId:'issue-planner',status:async()=>({enabled:false,phase:'disabled'})})
 return{entry,editor,settings}
}
test('settings form reads actual defaults and preserves non-form configuration on save',async()=>{
 const f=fixture(),read=await f.settings.read();assert.equal(read.value.enabled,false);assert.equal(read.value.maxAttempts,3)
 const saved=await f.settings.save({revision:read.revision,value:{...read.value,pollSeconds:600}})
 assert.equal(saved.value.pollSeconds,600);assert.equal(f.entry.options.config.provider,'keep-provider');assert.equal(f.entry.options.config.model,'keep-model')
})
test('enabling requires complete repository, independent CLI and source/skill directory configuration',async()=>{
 const f=fixture(),read=await f.settings.read()
 await assert.rejects(f.settings.save({revision:read.revision,value:{...read.value,enabled:true}}),e=>e.status===400)
 assert.equal(f.entry.options.config.enabled,false)
 const value={...read.value,enabled:true,repository:'owner/repo',plannerCli:'gh-planner',sourceDirectory:'/repo',skillsDirectory:'/skills'}
 await f.settings.save({revision:read.revision,value});assert.equal(f.entry.options.config.enabled,true)
})
test('stale tabs cannot overwrite configuration, including writes that race inside serialized editor',async()=>{
 const f=fixture(),read=await f.settings.read();f.entry.options.config.pollSeconds=900
 await assert.rejects(f.settings.save({revision:read.revision,value:read.value}),e=>e.status===409)
 const fresh=await f.settings.read(),edit=f.editor.edit.bind(f.editor)
 f.editor.edit=async(...args)=>{f.entry.options.config.maxAttempts=5;return edit(...args)}
 await assert.rejects(f.settings.save({revision:fresh.revision,value:fresh.value}),e=>e.status===409)
 assert.equal(f.entry.options.config.maxAttempts,5)
})
test('unknown fields, malformed switches and invalid scheduling bounds are rejected',async()=>{
 const f=fixture(),read=await f.settings.read()
 for(const change of [{enabled:'true'},{pollSeconds:59},{maxAttempts:0},{executionStallHours:0},{unexpected:1}])await assert.rejects(f.settings.save({revision:read.revision,value:{...read.value,...change}}),e=>e.status===400)
 assert.deepEqual(settingsValue({}).readyLabels,undefined)
})
test('settings endpoint requires loopback host and same-origin writes, validates request size',async()=>{
 const f=fixture(),handler=settingsHandler({settings:f.settings,origin:'http://127.0.0.1:3200',logger:{error(){}}})
 async function request(method,headers,body=''){
  const req=Readable.from([body]);Object.assign(req,{method,headers:{host:'127.0.0.1:3200','x-issue-planner-request':'1','content-type':'application/json',...headers}})
  const res={writeHead(status){this.status=status},end(body){this.body=body}}
  await handler(req,res);return res
 }
 assert.equal((await request('GET',{})).status,200)
 assert.equal((await request('PUT',{},'{}')).status,403)
 assert.equal((await request('PUT',{origin:'http://evil.test'},'{}')).status,403)
 assert.equal((await request('PUT',{origin:'http://127.0.0.1:3200'},'x'.repeat(20000))).status,413)
 assert.equal((await request('GET',{host:'evil.test:3200'})).status,403)
 assert.equal((await request('POST',{})).status,405)
})
