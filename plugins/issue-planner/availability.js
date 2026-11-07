export function admissionReady(state,settings,user,config){
 const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase()
 if(state.paused)throw new Error('Superagent paused')
 if(state.setup?.problem)throw new Error('Superagent setup not ready')
 const source=settings.sources?.find(s=>s.id==='github')
 if(!source?.value.enabled||!same(source.value.config.repository,config.repository)||!same(state.setup?.accounts?.repository,config.repository))throw new Error('GitHub source repository disabled or changed')
 if(!same(state.setup.accounts.agent,config.executorLogin))throw new Error('executor account changed')
 if(user.type!=='User'||/\[bot\]$/i.test(user.login)||same(user.login,config.executorLogin))throw new Error('planner must be a distinct regular GitHub account')
 const allowed=settings.blocks?.policy?.value?.sources?.github?.allowed
 if(!allowed?.some(a=>same(a.id,user.login)))throw new Error('planner account is not allowed to originate work')
}
export function superagentClient(origin,signal){
 const url=new URL(origin)
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/'||url.username||url['pass' + 'word']||url.search||url.hash)throw new Error('Superagent requires local HTTP origin')
 return async path=>{
  const response=await fetch(`${url.origin}/orchestrator/api/${path}`,{headers:{'x-orchestrator-request':'1'},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),redirect:'error'})
  if(!response.ok)throw new Error(`Superagent ${path}: HTTP ${response.status}`)
  return response.json()
 }
}
export async function runWhileAvailable(operation,check,parent,interval=15000){
 const controller=new AbortController(),signal=AbortSignal.any([parent,controller.signal])
 await check();signal.throwIfAborted()
 let stopped=false,timer,pending=Promise.resolve()
 const poll=()=>{pending=check().catch(error=>controller.abort(error)).finally(()=>{if(!stopped&&!signal.aborted)timer=setTimeout(poll,interval)})}
 timer=setTimeout(poll,interval)
 try{return await operation(signal)}finally{stopped=true;clearTimeout(timer);controller.abort();await pending}
}
export async function ticketInventory(get,repository){
 const busyNumbers=new Set(),byNumber=new Map(),ticketByNumber=new Map()
 let offset=0,total
 for(let page=0;page<100;page++){
  const data=await get(`tickets?state=open&offset=${offset}&limit=100`)
  if(!Array.isArray(data.items)||!Number.isInteger(data.total))throw new Error('ticket pagination incomplete')
  if(total!==undefined&&total!==data.total)throw new Error('ticket set changed during scan')
  total=data.total
  for(const ticket of data.items){
   if(!Array.isArray(ticket.threads))throw new Error('ticket thread list missing')
   for(const thread of ticket.threads){
    const match=/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/.exec(thread.url??'')
    if(match&&match[1].toLowerCase()===repository.toLowerCase()){
     const number=Number(match[2]);busyNumbers.add(number);byNumber.set(number,ticket.id);ticketByNumber.set(number,ticket)
    }else if(thread.source==='github')throw new Error('GitHub ticket has no verifiable repository link')
   }
  }
  offset+=data.items.length
  if(offset===total)return {busyNumbers,byNumber,ticketByNumber}
  if(!data.items.length||offset>total)break
 }
 throw new Error('ticket pagination incomplete')
}
