import { createHash } from 'node:crypto'
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const section = (text, name) => [...String(text??'').matchAll(new RegExp(`^#{1,6}\\s+(?:${name})\\s*:?\\s*$([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))`, 'gim'))].map(m=>m[1].trim()).join('\n')
const refs = text => [...text.matchAll(/(?:^|[^\w])#(\d+)\b/g)].map(m=>Number(m[1]))
const labels = issue => (issue.labels ?? []).map(l=>(typeof l==='string'?l:l.name).toLowerCase())
function parentOf(issue) {
 const body = section(issue.body, 'Parent|父 Issue|父任务')
 const parents = [...new Set([issue.parent, ...refs(body)].filter(Boolean))]
 if(parents.length>1 || body && !parents.length) throw new Error('conflicting or unresolved parent')
 return parents[0]
}
export function contextFor(snapshot, number) {
 const map = new Map(snapshot.issues.map(i=>[i.number,i])), result=[], seen=new Set()
 let next=number
 while(next) {
  if(seen.has(next)) throw new Error('parent cycle')
  seen.add(next);const item=map.get(next)
  if(!item) throw new Error(`unreadable parent #${next}`)
  result.unshift(item);next=parentOf(item)
 }
 return result
}
function dependencies(snapshot, issue, root) {
 const body=section(issue.body,'Blocked by|Depends on|依赖|阻塞依赖')
 const ids=new Set(issue.dependencies??[])
 for(const n of refs(body)) ids.add(n)
 const aliases=[...body.matchAll(/\bT\d+\b/gi)].map(m=>m[0].toUpperCase())
 for(const alias of aliases) {
  const matches=snapshot.issues.filter(i=>new RegExp(`\\b${alias}\\b`,'i').test(i.title) && contextFor(snapshot,i.number)[0].number===root.number)
  if(matches.length!==1) throw new Error(`ambiguous dependency ${alias}`)
  ids.add(matches[0].number)
 }
 if(body && !ids.size && !/^(?:[-*]\s*)?(?:none|无|无依赖)(?:\b|[（(\s]|$)/i.test(body)) throw new Error('unresolved body dependencies')
 return [...ids]
}
function assertDependencies(snapshot, issue, root, seen=new Set()) {
 if(seen.has(issue.number)) throw new Error('dependency cycle')
 const next=new Set(seen).add(issue.number)
 for(const number of dependencies(snapshot,issue,root)) {
  const dep=snapshot.issues.find(i=>i.number===number)
  if(!dep) throw new Error(`unreadable dependency #${number}`)
  if(dep.state!=='closed'||dep.state_reason!=='completed') throw new Error(`blocked by #${number}`)
  assertDependencies(snapshot,dep,contextFor(snapshot,dep.number)[0],next)
 }
}
export function evaluate(snapshot, config, busyNumbers=new Set()) {
 const candidates=[],skipped=[]
 for(const issue of snapshot.issues.filter(i=>i.state==='open')) {
  try {
   const ownLabels=labels(issue)
   if(!(config.readyLabels??['ready-for-agent']).some(l=>ownLabels.includes(l.toLowerCase()))) throw new Error('not ready labeled')
   if(busyNumbers.has(issue.number)) throw new Error('active ticket or implementation PR')
   if((issue.children??[]).some(n=>snapshot.issues.some(i=>i.number===n&&i.state==='open')) || snapshot.issues.some(i=>i.state==='open'&&i.number!==issue.number&&parentOf(i)===issue.number)) throw new Error('root tracker with open children')
   const chain=contextFor(snapshot,issue.number)
   for(const node of chain) {
    if((config.blockedLabels??['blocked']).some(l=>labels(node).includes(l.toLowerCase()))) throw new Error(`blocked label on #${node.number}`)
    const text=[node.body,...(node.comments??[]).map(c=>c.body)].join('\n')
    if(/待批准|尚未批准|未获批准|禁止实施|禁止执行|do not (?:implement|execute)|awaiting approval|pending approval|not approved/i.test(text)) throw new Error(`approval unresolved on #${node.number}`)
    assertDependencies(snapshot,node,chain[0])
   }
   candidates.push(issue)
  } catch(error) { skipped.push({number:issue.number,reason:error.message}) }
 }
 candidates.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||a.number-b.number)
 return {candidates,skipped}
}
export function relatedFor(snapshot, number) {
 const relevant=new Map()
 function add(issue) {
  if(relevant.has(issue.number))return
  relevant.set(issue.number,issue)
  for(const node of contextFor(snapshot,issue.number)) {
   if(!relevant.has(node.number))add(node)
   for(const n of dependencies(snapshot,node,contextFor(snapshot,node.number)[0])) {
    const dep=snapshot.issues.find(i=>i.number===n);if(!dep)throw new Error('missing dependency');add(dep)
   }
  }
 }
 add(snapshot.issues.find(i=>i.number===number))
 return [...relevant.values()].sort((a,b)=>a.number-b.number)
}
export function fingerprint(snapshot, number) {
 return digest(relatedFor(snapshot,number).map(i=>({number:i.number,title:i.title,body:i.body,state:i.state,state_reason:i.state_reason,parent:i.parent,children:i.children,dependencies:i.dependencies,labels:labels(i).sort(),comments:(i.comments??[]).filter(c=>!c.body?.includes('<!-- dsh-issue-planner:')).map(c=>({id:c.id,body:c.body,updated_at:c.updated_at}))})))
}
