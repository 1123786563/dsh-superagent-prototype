import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { command } from './github.js'
import { resourcePath } from './skills.js'
import { relatedFor } from './eligibility.js'
export function validatePlan(text,skillLoaded,reads){
 if(!skillLoaded)throw new Error('writing-plans skill was not loaded')
 if(!reads.length)throw new Error('no source files inspected')
 if(typeof text!=='string'||text.length>500000||/\bTBD\b|TODO:|待定/.test(text)||!['Goal','Architecture','Tech Stack','Spec','Global Constraints','Review Focus','Files','Interfaces','Expected'].every(s=>text.includes(s))||!text.includes('- [ ]')||!text.includes('Run:'))throw new Error('incomplete implementation plan')
}
function safePath(path){if(typeof path!=='string'||!path||path.startsWith('/')||path.split('/').some(p=>p==='..'||p==='.git')||/[\x00-\x1f\\]/.test(path))throw new Error('invalid repository path')}
export async function readBlob(source,commit,path,signal){
 safePath(path);if(!/^[0-9a-f]{40,64}$/.test(commit))throw new Error('invalid commit')
 const entry=await command('git',['-C',source,'ls-tree',commit,'--',path],{signal})
 if(!/^100(?:644|755) blob /.test(entry)||entry.trim().split('\n').length!==1)throw new Error('source path must be a tracked regular file')
 const text=await command('git',['-C',source,'show',`${commit}:${path}`],{signal,maxBuffer:2*1024*1024})
 if(text.includes('\0'))throw new Error('source is binary')
 return text
}
function tool(name,description,properties,required,execute){return{name,description,parameters:{type:'object',properties,required,additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute}}
export async function planIssue(ctx,config,skills,github,store,{snapshot,chain,record,signal}){
 const timeout=AbortSignal.timeout(config.planTimeoutSeconds*1000),combined=AbortSignal.any([signal,timeout])
 combined.throwIfAborted()
 const meta=await github.api(github.repo('')),head=await github.api(github.repo(`commits/${encodeURIComponent(meta.default_branch)}`)),commit=head.sha
 const remote=(await command('git',['-C',config.sourceDirectory,'remote','get-url','origin'],{signal:combined})).trim().replace(/\.git$/,'')
 if(!remote.toLowerCase().endsWith('/'+config.repository.toLowerCase())&&!remote.toLowerCase().endsWith(':'+config.repository.toLowerCase()))throw new Error('sourceDirectory origin differs from target repository')
 await command('git',['-C',config.sourceDirectory,'cat-file','-e',`${commit}^{commit}`],{signal:combined})
 const sessionId=`issue-plan-${randomUUID()}`,cwd=join(store.root,'sessions',sessionId)
 await mkdir(cwd,{recursive:true,mode:0o700})
 record.sessionId=sessionId;record.commit=commit;record.skillDigest=skills.digest;await store.save()
 const files=(await command('git',['-C',config.sourceDirectory,'ls-tree','-r','--name-only',commit],{signal:combined})).trim().split('\n')
 const context=JSON.stringify({chain,related:relatedFor(snapshot,record.number).filter(i=>!chain.includes(i)),repository:config.repository,commit})
 let loaded=false,submitted,readChars=context.length;const reads=[],releases=[]
 const charge=text=>{readChars+=text.length;if(readChars>config.maxContextChars)throw new Error('planner aggregate context budget exhausted');return text}
 charge('')
 const handle=await ctx.agents.create({sessionId,meta:{cwd},agentOptions:config.provider?{provider:config.provider,model:config.model,...config.reasoningEffort?{reasoningEffort:config.reasoningEffort}:{}}:ctx.agentDefaultModel.currentSelection(),signal:combined,
  setup:async(agentCtx)=>{
   // Globals are hidden; only these bounded capability tools can run in this planner.
   releases.push(agentCtx.tools.restrict({allow:[]}))
   const register=definition=>releases.push(agentCtx.tools.register(definition))
   register(tool('skill','Load a superpowers skill by its DSH name.',{name:{type:'string'}},['name'],async({name})=>{
    const skill=skills.registrations.find(s=>s.name===name);if(!skill)throw new Error('unknown skill')
    if(name==='superpowers-writing-plans')loaded=true
    return{content:charge(skill.content),resourceBase:skill.resourceBase.path}
   }))
   register(tool('planner_resource','Read a skill reference relative to the configured superpowers skills root.',{path:{type:'string'}},['path'],async({path})=>{
    const content=await readFile(await resourcePath(skills.root,path),'utf8');if(content.length>100000)throw new Error('skill resource too large');return{content:charge(content)}
   }))
   register(tool('planner_files','Find tracked repository paths containing a literal fragment; results are paginated.',{contains:{type:'string'},offset:{type:'integer',minimum:0}},[],async({contains='',offset=0})=>{
    const matches=files.filter(f=>f.includes(contains));charge(matches.slice(offset,offset+100).join('\n'));return{paths:matches.slice(offset,offset+100),total:matches.length,nextOffset:offset+100<matches.length?offset+100:null}
   }))
   register(tool('planner_read','Read lines from a regular file at the pinned repository commit.',{path:{type:'string'},offset:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:500}},['path'],async({path,offset=1,limit=200})=>{
    const content=await readBlob(config.sourceDirectory,commit,path,combined),lines=content.split('\n'),text=lines.slice(offset-1,offset-1+limit).join('\n')
    charge(text)
    reads.push(path);return{path,commit,offset,text,totalLines:lines.length}
   }))
   register(tool('planner_search','Search pinned tracked source with a literal string and return at most 100 matching lines.',{text:{type:'string',minLength:1},path:{type:'string'}},['text'],async({text,path})=>{
    if(path)safePath(path)
    try{const output=await command('git',['-C',config.sourceDirectory,'grep','-n','-I','-F','-e',text,commit,'--',...path?[path]:[]],{signal:combined,maxBuffer:2*1024*1024});const lines=output.split('\n');charge(lines.slice(0,100).join('\n'));return{matches:lines.slice(0,100),truncated:lines.length>100}}catch(error){if(error.cause?.code===1)return{matches:[],truncated:false};throw error}
   }))
   register(tool('planner_submit','Submit a self-reviewed complete implementation plan for durable handoff.',{text:{type:'string'}},['text'],async({text},exec)=>{
    combined.throwIfAborted();validatePlan(text,loaded,reads);store.assertHeld()
    submitted={text,commit,sessionId,skillDigest:skills.digest,sourceReads:[...new Set(reads)]};exec.concludeTurn();return{accepted:true}
   }))
   const prompt=await readFile(new URL('./prompts/plan-issue.md',import.meta.url),'utf8')
   releases.push(agentCtx.systemPrompt.section({name:'issue-planner',order:100,text:prompt+'\nPinned commit: '+commit}))
  }})
 const cancel=()=>handle.agent.cancel({kind:'hook',reason:'issue planner stopped'})
 combined.addEventListener('abort',cancel,{once:true})
 try{
  combined.throwIfAborted()
  handle.agent.followup({content:[{type:'text',text:'Write the implementation plan for issue #'+record.number+'. Root-first issue context:\n'+context}],source:{kind:'user'}})
  // Exact submission plus committed turn end establishes completion; idle alone does not.
  await handle.agent.whenIdle();combined.throwIfAborted()
  const end=handle.agent.session.ownEvents().filter(e=>e.type==='turn/end').at(-1)
  if(!submitted||end?.data.reason.kind!=='completed')throw new Error('planner stopped without a completed plan submission')
  return submitted
 }finally{combined.removeEventListener('abort',cancel);await handle.dispose();for(const release of releases.reverse())release()}
}
