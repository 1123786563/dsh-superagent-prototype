import s from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Github } from './github.js'
import { openStore } from './store.js'
import { Engine } from './engine.js'
import { loadSkills } from './skills.js'
import { planIssue } from './planner.js'
import { admissionReady, superagentClient, ticketInventory, runWhileAvailable } from './availability.js'
export const name='dsh-issue-planner'
export const inject=['agents','agentDefaultModel','skills','tools','webServer']
export const Config=s.object({
 enabled:s.boolean().default(false).description('启用定时规划和独立账号评论交接。'),
 repository:s.string().default('').description('owner/repo；须与 Superagent 正在监听的仓库一致。'),
 plannerCli:s.string().default('').description('以独立规划账号登录的 GitHub CLI 包装命令，不能使用执行账号。'),
 executorLogin:s.string().default('wuyj-agent'),
 sourceDirectory:s.string().default('').description('目标仓库本地目录，须含 GitHub 默认分支最新 commit；仅读取 Git 对象。'),
 skillsDirectory:s.string().default('').description('完整 superpowers skills 目录，包含技能、引用及执行脚本。'),
 stateDir:s.string().default('').description('留空使用本机统一状态根 ~/.dsh/state/issue-planner；设置时须为同一路径。'),
 pollSeconds:s.number().min(60).max(3600).step(1).default(300),
 planTimeoutSeconds:s.number().min(60).max(3600).step(1).default(1200),
 maxContextChars:s.number().min(10000).max(500000).step(1).default(180000),
 maxAttempts:s.number().min(1).max(10).step(1).default(3),
 readyLabels:s.array(s.string()).default(['ready-for-agent']),
 blockedLabels:s.array(s.string()).default(['blocked','on-hold']),
 superagentOrigin:s.string().default('http://127.0.0.1:3200'),
 provider:s.string().default(''),model:s.string().default(''),reasoningEffort:s.string().default(''),
})
export async function apply(ctx,input){
 const controller=new AbortController(),signal=controller.signal,releases=[]
 let running=Promise.resolve(),timer,store,engine,skills,github,get,login,nextPollAt=null
 let status={phase:input.enabled?'starting':'disabled'}
 const statusRoute=ctx.webServer.register({kind:'exact',path:'/issue-planner/api/status',handler:(req,res)=>{
  const host=req.headers.host,port=new URL(ctx.webServer.getOrigin()).port
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||req.headers['x-issue-planner-request']!=='1'||req.headers.origin&&req.headers.origin!==`http://${host}`){res.writeHead(403);res.end();return}
  if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end();return}
  const url=new URL(req.url,`http://${host}`),offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??50)
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100){res.writeHead(400);res.end();return}
  const records=Object.values(store?.data.records??{}),current=engine?.status??status
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'})
  res.end(JSON.stringify({schemaVersion:1,enabled:input.enabled,repository:input.repository,plannerLogin:login??null,executorLogin:input.executorLogin,nextPollAt,...current,
   skipped:current.skipped?.slice(offset,offset+limit),skippedTotal:current.skipped?.length??0,
   records:{total:records.length,offset,items:records.slice(offset,offset+limit).map(({number,state,commentId,commentUrl,sessionId,error,ticketId})=>({number,state,commentId,commentUrl,sessionId,error,ticketId}))}}))
 }})
 ctx.effect(()=>async()=>{controller.abort();clearTimeout(timer);statusRoute();await running;for(const release of releases.reverse())release();await store?.close()})
 if(!input.enabled)return
 async function initialize(){
  if(!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repository)||!input.plannerCli||!input.sourceDirectory||!input.skillsDirectory)throw new Error('repository, plannerCli, sourceDirectory and skillsDirectory are required')
  if(!/^[a-z0-9-]+$/i.test(input.executorLogin))throw new Error('invalid executor login')
  if(!!input.provider!==!!input.model)throw new Error('provider and model must be configured together')
  const canonical=join(homedir(),'.dsh','state','issue-planner')
  if(input.stateDir&&resolve(input.stateDir)!==canonical)throw new Error('stateDir must use the canonical host repository lock root: '+canonical)
  get=superagentClient(input.superagentOrigin,signal)
  github=new Github({repository:input.repository,cli:input.plannerCli},signal)
  const user=await github.api('user'),[state,settings]=await Promise.all([get('state'),get('settings')])
  admissionReady(state,settings,user,input);login=user.login
  const permissions=await github.api(github.repo(''))
  if(!permissions.permissions?.push)throw new Error('planner account requires repository write permission')
  skills=await loadSkills(input.skillsDirectory)
  // Global aliases make the exact same execution skill available to existing worker scopes.
  for(const skill of skills.registrations){
   const existing=await ctx.skills.get(skill.name)
   if(existing&&existing.content!==skill.content)throw new Error(`conflicting runtime skill ${skill.name}`)
  }
  store=await openStore(canonical,input.repository,()=>controller.abort())
  for(const skill of skills.registrations)releases.push(ctx.skills.register(skill))
  const config={...input,plannerLogin:login}
  const available=async()=>{
   signal.throwIfAborted();store.assertHeld()
   const [state,settings,currentUser]=await Promise.all([get('state'),get('settings'),github.api('user')])
   if(currentUser.login.toLowerCase()!==login.toLowerCase())throw new Error('planner account changed')
   admissionReady(state,settings,currentUser,input)
   const inventory=await ticketInventory(get,input.repository)
   for(const record of Object.values(store.data.records))if(record.state==='handed_off'&&inventory.byNumber.has(record.number))record.ticketId=inventory.byNumber.get(record.number)
   return inventory
  }
  engine=new Engine({github,store,config,available,signal,plan:request=>runWhileAvailable(planSignal=>planIssue(ctx,input,skills,github,store,{...request,signal:planSignal}),available,signal)})
 }
 const cycle=()=>{
  nextPollAt=null
  running=(async()=>{if(!engine)await initialize();await engine.tick()})().catch(error=>{status={phase:'not_ready',error:error.message};ctx.logger.warn('Issue planner: %s',error.message)})
   .finally(()=>{if(!signal.aborted){nextPollAt=new Date(Date.now()+input.pollSeconds*1000).toISOString();timer=setTimeout(cycle,input.pollSeconds*1000);timer.unref?.()}})
 }
 cycle()
}
