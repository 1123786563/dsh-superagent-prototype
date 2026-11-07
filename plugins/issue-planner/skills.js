import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { digest } from './eligibility.js'
export async function loadSkills(directory){
 const root=await realpath(directory),registrations=[],hashes=[]
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory())continue
  const path=join(root,entry.name,'SKILL.md');let text
  try{text=await readFile(path,'utf8')}catch(e){if(e.code==='ENOENT')continue;throw e}
  const description=/^description:\s*(.+)$/m.exec(text)?.[1],name=/^name:\s*([a-z][a-z0-9-]*)\s*$/m.exec(text)?.[1]
  if(!name||!description)throw new Error(`invalid skill metadata: ${path}`)
  const content=text.replace(/^---\n[\s\S]*?\n---\n/,'').replaceAll('superpowers:','superpowers-')
  registrations.push({name:`superpowers-${name}`,description,content,source:'runtime',path,resourceBase:{kind:'directory',path:join(root,entry.name)}})
 }
 for(const required of ['writing-plans','executing-plans','test-driven-development','verification-before-completion','using-git-worktrees','finishing-a-development-branch','requesting-code-review','subagent-driven-development','systematic-debugging']){
  if(!registrations.some(s=>s.name===`superpowers-${required}`))throw new Error(`required superpowers skill missing: ${required}`)
 }
 for(const resource of ['executing-plans/scripts/task-start','executing-plans/scripts/task-done','subagent-driven-development/scripts/sdd-workspace','subagent-driven-development/scripts/review-package','requesting-code-review/code-reviewer.md','subagent-driven-development/scripts/task-brief','test-driven-development/writing-good-tests.md','systematic-debugging/root-cause-tracing.md','systematic-debugging/defense-in-depth.md','systematic-debugging/condition-based-waiting.md']){
  if(!(await stat(join(root,resource))).isFile())throw new Error(`missing skill resource ${resource}`)
 }
 async function hashTree(path){for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const full=join(path,item.name);if(item.isSymbolicLink())throw new Error('skill resource symlinks unsupported')
  if(item.isDirectory())await hashTree(full);else if(item.isFile())hashes.push([relative(root,full),digest(await readFile(full))])
 }}
 await hashTree(root)
 return {root,registrations,digest:digest(hashes)}
}
export async function resourcePath(root,path){
 const resolved=await realpath(join(root,path)),rel=relative(root,resolved)
 if(rel.startsWith('..')||isAbsolute(rel))throw new Error('skill resource path escapes root')
 return resolved
}
