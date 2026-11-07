import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSkills } from '../skills.js'
import { validatePlan, readBlob } from '../planner.js'
import { admissionReady, runWhileAvailable } from '../availability.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'planner-skills-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const name of ['writing-plans','executing-plans','test-driven-development','verification-before-completion','using-git-worktrees','finishing-a-development-branch','requesting-code-review','subagent-driven-development','systematic-debugging']){
  await mkdir(join(root,name),{recursive:true});await writeFile(join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: test ${name}\n---\nUse superpowers:executing-plans.\n`)
 }
 for(const path of ['executing-plans/scripts/task-start','executing-plans/scripts/task-done','subagent-driven-development/scripts/sdd-workspace','subagent-driven-development/scripts/review-package','subagent-driven-development/scripts/task-brief','requesting-code-review/code-reviewer.md','test-driven-development/writing-good-tests.md','systematic-debugging/root-cause-tracing.md','systematic-debugging/defense-in-depth.md','systematic-debugging/condition-based-waiting.md']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'resource')}
 return root
}
test('missing skill directory fails; complete skill resources load',async t=>{
 const skillsRoot=await fixture(t)
 await assert.rejects(loadSkills('/nonexistent/superpowers'))
 const result=await loadSkills(skillsRoot)
 assert.ok(result.registrations.some(s=>s.name==='superpowers-executing-plans'))
 assert.ok(result.registrations.find(s=>s.name==='superpowers-writing-plans').content.includes('superpowers-executing-plans'))
 assert.equal(result.digest.length,64)
})
test('missing transitive task-brief resource blocks activation',async t=>{
 const root=await fixture(t);await rm(join(root,'subagent-driven-development/scripts/task-brief'))
 await assert.rejects(loadSkills(root))
})
test('pause monitor cancels an active planner before its timeout',async()=>{
 const controller=new AbortController();let checks=0
 const result=await runWhileAvailable(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve('cancelled'),{once:true})),async()=>{if(++checks>1)throw new Error('paused')},controller.signal,1)
 assert.equal(result,'cancelled')
})
test('planner must load writing skill, read source and submit concrete checked plan',()=>{
 assert.throws(()=>validatePlan('TBD',false,[]),/skill/)
 assert.throws(()=>validatePlan('TBD',true,[]),/source/)
 assert.throws(()=>validatePlan('TBD',true,['package.json']),/incomplete/)
 const plan='# Feature Implementation Plan\nGoal: deliver\nArchitecture: modules\nTech Stack: Node\nSpec: #1\nGlobal Constraints: root\nReview Focus: failures\n### Task 1\nFiles: src/a.js\nInterfaces: work()\n- [ ] Write failing test\nRun: node --test tests/a.js\nExpected: PASS\n'
 assert.doesNotThrow(()=>validatePlan(plan,true,['package.json']))
})
test('git blob reads reject untrusted paths before executing git',async()=>{
 for(const path of ['../secret','/etc/passwd','.git/config','a\0b'])await assert.rejects(readBlob('/none','a'.repeat(40),path),/path/)
})
test('independent allowlisted regular account is required for explicit dispatch',()=>{
 const state={paused:false,setup:{problem:null,accounts:{repository:'o/r',agent:'wuyj-agent'}}}
 const settings={sources:[{id:'github',value:{enabled:true,config:{repository:'o/r'}}}],blocks:{policy:{value:{sources:{github:{allowed:[{id:'planner'}]}}}}}}
 const config={repository:'o/r',executorLogin:'wuyj-agent'}
 assert.doesNotThrow(()=>admissionReady(state,settings,{login:'planner',type:'User'},config))
 for(const user of [{login:'wuyj-agent',type:'User'},{login:'unknown',type:'User'},{login:'planner',type:'Bot'}])assert.throws(()=>admissionReady(state,settings,user,config))
 assert.throws(()=>admissionReady({...state,paused:true},settings,{login:'planner',type:'User'},config),/paused/)
})
