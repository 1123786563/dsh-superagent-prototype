import { digest } from './eligibility.js'
export const marker=(record,part)=>`<!-- dsh-issue-planner:${record.key}:${part} -->`
function literalPlan(text){
 const longest=Math.max(2,...[...text.matchAll(/`+/g)].map(m=>m[0].length))
 if(longest>1000)throw new Error('plan contains an excessive code fence')
 const fence='`'.repeat(longest+1)
 return `${fence}markdown\n${text}\n${fence}`
}
export async function publish({github,store,config,record,available,revalidate=async()=>{}}) {
 const assertAllowed=async()=>{store.assertHeld();await available();store.assertHeld()}
 const find=async part=>{
  const tag=marker(record,part),items=(await github.comments(record.number)).filter(c=>c.user?.login?.toLowerCase()===config.plannerLogin.toLowerCase()&&c.body?.includes(tag))
  if(items.length>1)throw new Error('duplicate planner comment marker; manual reconciliation required')
  return items[0]
 }
 record.receipts??={}
 const confirmed=record.receipts.handoff??await find('handoff')
 if(confirmed){record.commentId=confirmed.id;record.commentUrl=confirmed.html_url;record.state='handed_off';await store.save();return}
 const text=record.text,parts=[]
 if(text.length>48000)for(let offset=0;offset<text.length;offset+=48000)parts.push(text.slice(offset,offset+48000))
 record.parts??=[]
 async function send(part,body){
  const existing=record.receipts[part]??await find(part)
  if(existing){record.receipts[part]=existing;if(record.pending?.part===part)record.pending=null;await store.save();return existing}
  if(record.pending?.part===part){record.state='publish_uncertain';await store.save();return null}
  await assertAllowed();await revalidate()
  record.state='publishing';record.pending={part,bodyHash:digest(body),at:new Date().toISOString()};await store.save()
  try {
   // Persisting intent before dispatch intentionally favors no duplicates over automatic retry.
   await assertAllowed()
   const receipt=await github.postComment(record.number,body)
   if(!receipt?.id||!receipt.html_url)throw new Error('missing GitHub comment receipt')
   store.assertHeld();record.receipts[part]={id:receipt.id,html_url:receipt.html_url};record.pending=null;await store.save();return receipt
  }catch(error){record.state='publish_uncertain';record.error=error.message;await store.save();return null}
 }
 for(let i=0;i<parts.length;i++){
  const receipt=await send(`part-${i+1}`,`实施计划 ${i+1}/${parts.length}\n\n${literalPlan(parts[i])}\n\n${marker(record,`part-${i+1}`)}`)
  if(!receipt)return
  record.parts[i]={id:receipt.id,url:receipt.html_url};await store.save()
 }
 const content=parts.length?record.parts.map((p,i)=>`- [实施计划 ${i+1}/${parts.length}](${p.url})`).join('\n'):literalPlan(text)
 const body=`@${config.executorLogin} 请依据以下完整实施计划，使用 /superpowers:executing-plans（DSH 技能名 superpowers-executing-plans）逐任务执行。先读取根需求、规格及计划，记录进展并运行验证；完成后在本 issue 回报结果与 PR。\n\n计划版本：${record.key}\n代码 commit：${record.commit??'unknown'}\n\n${content}\n\n${marker(record,'handoff')}`
 const receipt=await send('handoff',body)
 if(receipt){record.commentId=receipt.id;record.commentUrl=receipt.html_url;record.state='handed_off';record.pending=null;record.handedOffAt=new Date().toISOString();await store.save()}
}
