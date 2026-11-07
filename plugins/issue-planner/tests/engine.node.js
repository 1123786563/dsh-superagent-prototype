import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../engine.js'
import { publish, marker } from '../publisher.js'
function fixture(){
 const comments=[],posts=[];let plans=0,allowed=true
 const issues=[1,2].map(number=>({number,node_id:`I${number}`,title:`Task ${number}`,state:'open',body:'',labels:[{name:'ready-for-agent'}],created_at:'2026-01-01',children:[],dependencies:[],comments:[]}))
 const github={scan:async()=>({issues}),comments:async()=>comments,postComment:async(n,body)=>{posts.push(body);const c={id:posts.length,html_url:`https://github.com/o/r/issues/${n}#issuecomment-${posts.length}`,body,user:{login:'planner'}};comments.push(c);return c},busyNumbers:async()=>new Set()}
 const store={data:{schemaVersion:1,records:{}},save:async()=>{},assertHeld(){}}
 const config={repository:'o/r',executorLogin:'wuyj-agent',readyLabels:['ready-for-agent'],blockedLabels:['blocked'],plannerLogin:'planner',maxAttempts:3}
 const available=async()=>{if(!allowed)throw new Error('paused');return {busyNumbers:new Set()}}
 const engine=new Engine({github,store,config,available,plan:async()=>{plans++;return{text:'implementation plan',commit:'a'.repeat(40),sessionId:'session'}}})
 return{engine,github,store,config,posts,comments,available,issues,get plans(){return plans},pause(){allowed=false}}
}
test('blocked implementation is observed without reassigning it or blocking the next issue',async()=>{
 const f=fixture();f.store.data.records.I1={number:1,state:'handed_off',handedOffAt:new Date().toISOString()}
 f.engine.available=async()=>({busyNumbers:new Set([1]),ticketByNumber:new Map([[1,{id:'t1',stage:'person',action:'blocked',updatedAt:new Date().toISOString()}]])})
 await f.engine.tick()
 assert.equal(f.store.data.records.I1.executionStatus,'execution_blocked');assert.equal(f.store.data.records.I1.state,'handed_off');assert.equal(f.store.data.records.I2.state,'handed_off');assert.equal(f.plans,1)
})
test('each tick plans one issue and handed-off issues are never replanned',async()=>{
 const f=fixture();await f.engine.tick();assert.equal(f.plans,1);assert.equal(f.posts.length,1)
 await f.engine.tick();assert.equal(f.plans,2);assert.equal(f.posts.length,2)
 await f.engine.tick();assert.equal(f.posts.length,2)
})
test('ambiguous POST is reconciled, never automatically resent after restart',async()=>{
 const f=fixture();f.github.postComment=async()=>{throw new Error('timeout')}
 await f.engine.tick();assert.equal(f.store.data.records.I1.state,'publish_uncertain')
 f.store.data.records.I1.reconcileAfter=0
 f.engine=new Engine({...f.engine});await f.engine.tick();assert.equal(f.plans,2)
 assert.equal(f.store.data.records.I1.state,'publish_uncertain')
})
test('uncertain issue is quarantined while later eligible issues continue without resending it',async()=>{
 const f=fixture();let attempts=0
 f.github.postComment=async(number,body)=>{attempts++;if(number===1)throw new Error('timeout');f.posts.push(body);return{id:2,html_url:'https://github.com/o/r/issues/2#issuecomment-2'}}
 await f.engine.tick();await f.engine.tick();await f.engine.tick()
 assert.equal(f.plans,2);assert.equal(attempts,2);assert.equal(f.store.data.records.I1.state,'publish_uncertain');assert.equal(f.store.data.records.I2.state,'handed_off')
})
test('an unreadable comment list for one quarantined issue does not block another issue',async()=>{
 const f=fixture();f.github.postComment=async()=>{throw new Error('timeout')};await f.engine.tick()
 f.store.data.records.I1.reconcileAfter=0
 f.github.comments=async number=>{if(number===1)throw new Error('issue comments unavailable');return []}
 f.github.postComment=async()=>({id:2,html_url:'https://github.com/o/r/issues/2#issuecomment-2'})
 await f.engine.tick();assert.equal(f.store.data.records.I2.state,'handed_off')
})
test('restart after the final interrupted attempt cannot exceed the issue retry budget',async()=>{
 const f=fixture();f.store.data.records.I1={number:1,state:'planning',attempts:3,text:null}
 await f.engine.tick();assert.equal(f.store.data.records.I1.state,'needs_attention');assert.equal(f.store.data.records.I2.state,'handed_off');assert.equal(f.plans,1)
})
test('a saved final-attempt plan becoming stale cannot start a fourth plan after restart',async()=>{
 const f=fixture();f.store.data.records.I1={number:1,state:'planned',attempts:3,text:'old plan',fingerprint:'older context'}
 await f.engine.tick();assert.equal(f.plans,0);assert.equal(f.store.data.records.I1.state,'needs_attention')
 await f.engine.tick();assert.equal(f.store.data.records.I2.state,'handed_off');assert.equal(f.plans,1)
})
test('stale multipart recovery cannot bypass an exhausted planning budget in the same tick',async()=>{
 const f=fixture();f.store.data.records.I1={number:1,key:'old',state:'publishing',attempts:3,text:'x'.repeat(70000),fingerprint:'older context',receipts:{'part-1':{id:1,html_url:'https://github.com/o/r/issues/1#issuecomment-1'}}}
 await f.engine.tick();assert.equal(f.plans,0);assert.equal(f.posts.length,0);assert.equal(f.store.data.records.I1.state,'needs_attention')
 await f.engine.tick();assert.equal(f.store.data.records.I2.state,'handed_off')
})
test('planning cooldown skips the smallest failed issue and bounded attempts survive context edits',async()=>{
 const f=fixture();let calls=0
 f.engine.plan=async({record})=>{if(record.number===1){calls++;throw new Error('planner stuck')}return{text:'plan',commit:'a',sessionId:'s'}}
 await f.engine.tick();await f.engine.tick();assert.equal(f.store.data.records.I2.state,'handed_off')
 for(let i=0;i<2;i++){f.store.data.records.I1.retryAt=0;f.issues[0].body='revision '+i;await f.engine.tick()}
 f.store.data.records.I1.retryAt=0;f.issues[0].body='another revision';await f.engine.tick()
 assert.equal(calls,3);assert.equal(f.store.data.records.I1.state,'needs_attention')
})
test('persisted receipt prevents resend even when remote comment was deleted',async()=>{
 const f=fixture();await f.engine.tick();const record=f.store.data.records.I1
 record.state='publishing';f.comments.length=0
 await f.engine.tick();assert.equal(f.posts.length,1);assert.equal(record.state,'handed_off')
})
test('success without local receipt is recovered by author and exact marker',async()=>{
 const f=fixture();const record={number:1,key:'abc',text:'plan',state:'publishing',parts:[]}
 f.comments.push({id:7,html_url:'https://github.com/o/r/issues/1#issuecomment-7',body:`existing\n${marker(record,'handoff')}`,user:{login:'planner'}})
 await publish({github:f.github,store:f.store,config:f.config,record,available:f.available})
 assert.equal(record.commentId,7);assert.equal(record.state,'handed_off');assert.equal(f.posts.length,0)
})
test('pause after planning prevents publication; lock loss prevents publication',async()=>{
 for(const stop of [f=>f.pause(),f=>{f.store.assertHeld=()=>{throw new Error('lost lock')}}]){
  const f=fixture();f.engine.plan=async()=>{stop(f);return{text:'plan',commit:'a',sessionId:'s'}}
  await f.engine.tick();assert.equal(f.posts.length,0)
 }
})
test('recovering an earlier confirmed part cannot clear a later uncertain handoff',async()=>{
 const f=fixture(),record={number:1,key:'partial',text:'x'.repeat(70000),state:'publish_uncertain',parts:[],receipts:{'part-1':{id:1,html_url:'https://github.com/o/r/issues/1#issuecomment-1'},'part-2':{id:2,html_url:'https://github.com/o/r/issues/1#issuecomment-2'}},pending:{part:'handoff'}}
 await publish({github:f.github,store:f.store,config:f.config,record,available:f.available})
 assert.equal(f.posts.length,0);assert.equal(record.state,'publish_uncertain');assert.equal(record.pending.part,'handoff')
})
test('publication preserves package scopes, decorators and literal account names verbatim',async()=>{
 const f=fixture(),text='Run: npm install @deepseek-ai/dsh\n```py\n@dataclass\nclass Item: pass\n```\nOwner: @wuyj-agent'
 await publish({github:f.github,store:f.store,config:f.config,record:{number:1,key:'verbatim',text,state:'planned'},available:f.available})
 assert.ok(f.posts[0].includes(text));assert.ok(f.posts[0].includes('````markdown'));assert.ok(!f.posts[0].includes('\u200b'))
})
test('large plans use parts with no mentions and exactly one handoff manifest',async()=>{
 const f=fixture();const record={number:1,key:'large',text:'x'.repeat(70000)+' @wuyj-agent',state:'planned',parts:[]}
 await publish({github:f.github,store:f.store,config:f.config,record,available:f.available})
 assert.equal(f.posts.length,3);assert.ok(f.posts.every(b=>b.length<60000))
 assert.equal(f.posts.filter(b=>b.startsWith('@wuyj-agent')).length,1)
})
test('restart after a confirmed part rechecks current eligibility before sending another comment',async()=>{
 const f=fixture();await f.engine.tick()
 const record=f.store.data.records.I1;record.state='publishing';record.commentId=null
 f.comments.length=0;record.pending=null;record.receipts={};f.issues[0].state='closed'
 await f.engine.tick();assert.equal(f.posts.length,2);assert.equal(record.state,'stale');assert.equal(f.store.data.records.I2.state,'handed_off')
})
test('default branch advances or execution skill changes invalidate unpublished plans',async()=>{
 for(const change of ['code','skills']){
  const f=fixture()
  if(change==='code')f.github.defaultCommit=async()=> 'b'.repeat(40)
  else f.config.skillDigest='new-version'
  await f.engine.tick();assert.equal(f.posts.length,0)
 }
})
test('changed requirements before publishing invalidate plan',async()=>{
 const f=fixture();f.engine.plan=async()=>{f.issues[0].body='new requirement';return{text:'plan',commit:'a',sessionId:'s'}}
 await f.engine.tick();assert.equal(f.posts.length,0);assert.equal(f.store.data.records.I1.state,'stale')
})
