import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, contextFor, fingerprint } from '../eligibility.js'
const config = { readyLabels: ['ready-for-agent'], blockedLabels: ['blocked'] }
const issue = (number, patch = {}) => ({ number, node_id: `I_${number}`, title: `Task ${number}`, body: '', state: 'open', labels: [{ name: 'ready-for-agent' }], created_at: '2026-01-01', comments: [], parent: null, children: [], dependencies: [], ...patch })
const snapshot = (...issues) => ({ issues })
test('root trackers are context; leaf ordering is stable and root-first', () => {
 const s = snapshot(issue(3, {parent:1}), issue(1, {children:[3,2]}), issue(2, {parent:1}))
 assert.deepEqual(evaluate(s,config).candidates.map(i=>i.number),[2,3])
 assert.deepEqual(contextFor(s,3).map(i=>i.number),[1,3])
})
test('every dependency heading contributes blockers, including later Depends on sections',()=>{
 const s=snapshot(issue(1,{body:'## Blocked by\nNone\n\n## Depends on\n#2'}),issue(2))
 assert.deepEqual(evaluate(s,config).candidates.map(i=>i.number),[2])
})
test('body aliases block even when native dependency count is zero', () => {
 const s = snapshot(issue(1,{children:[2,3]}),issue(2,{parent:1,title:'[Corsair T1] Start'}),issue(3,{parent:1,body:'## Blocked by\n- T1（prerequisite）'}))
 assert.deepEqual(evaluate(s,config).candidates.map(i=>i.number),[2])
 s.issues[1].state='closed';s.issues[1].state_reason='completed'
 assert.deepEqual(evaluate(s,config).candidates.map(i=>i.number),[3])
 s.issues[1].state_reason='not_planned'
 assert.equal(evaluate(s,config).candidates.length,0)
})
test('pending root approval, blocked comments, busy tickets and labels prevent planning', () => {
 for(const patch of [{body:'待批准'}, {comments:[{body:'实施尚未批准'}]}, {labels:[{name:'blocked'}]}]) {
  const s=snapshot(issue(1,{children:[2],...patch}),issue(2,{parent:1}))
  assert.equal(evaluate(s,config).candidates.length,0)
 }
 assert.equal(evaluate(snapshot(issue(2)),config,new Set([2])).candidates.length,0)
})
test('conflicting parents, unknown aliases and native missing dependencies fail closed', () => {
 for(const patch of [{parent:1,body:'## Parent\n#9'},{body:'## Blocked by\n- T99'}, {dependencies:[99]}]) {
  assert.equal(evaluate(snapshot(issue(2,patch)),config).candidates.length,0)
 }
 assert.throws(()=>contextFor(snapshot(issue(1,{parent:2}),issue(2,{parent:1})),1),/cycle/)
})
test('closed parent is context; open dependency on ancestor is still blocking',()=>{
 const s=snapshot(issue(1,{state:'closed',state_reason:'completed',children:[2]}),issue(2,{parent:1,dependencies:[3]}),issue(3))
 assert.deepEqual(evaluate(s,config).candidates.map(i=>i.number),[3])
})
test('explicit body parents are followed and ordinary comments affect unpublished fingerprint',()=>{
 const s=snapshot(issue(1,{children:[2]}),issue(2,{body:'## Parent\n- #1\n\n## Blocked by\n- None（可立即开始）'}))
 assert.deepEqual(contextFor(s,2).map(i=>i.number),[1,2])
 const before=fingerprint(s,2);s.issues[0].comments.push({body:'require another test'})
 assert.notEqual(fingerprint(s,2),before)
})
