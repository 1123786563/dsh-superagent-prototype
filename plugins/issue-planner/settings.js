import s from '@deepseek-ai/schemastery'
import { digest } from './eligibility.js'

export const name='dsh-issue-planner-settings'
export const inject=['configEditor','webServer']
export const Config=s.object({entryId:s.string().default('issue-planner')})
const defaults={enabled:false,repository:'',plannerCli:'',executorLogin:'wuyj-agent',sourceDirectory:'',skillsDirectory:'',pollSeconds:300,planTimeoutSeconds:1200,maxAttempts:3,reconcileSeconds:300,handoffTimeoutMinutes:30,executionStallHours:24}
const bounds={pollSeconds:[60,3600],planTimeoutSeconds:[60,3600],maxAttempts:[1,10],reconcileSeconds:[60,3600],handoffTimeoutMinutes:[1,1440],executionStallHours:[1,168]}
class HttpError extends Error{constructor(status,message){super(message);this.status=status}}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const revision=raw=>digest(raw)
export function settingsValue(raw){return Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,raw[key]??value]))}
function validate(value){
 if(!object(value)||Object.keys(value).length!==Object.keys(defaults).length||Object.keys(value).some(key=>!Object.hasOwn(defaults,key)))throw new HttpError(400,'设置字段不完整或包含不允许修改的字段。')
 if(typeof value.enabled!=='boolean')throw new HttpError(400,'开关必须为布尔值。')
 for(const [key,range] of Object.entries(bounds))if(!Number.isInteger(value[key])||value[key]<range[0]||value[key]>range[1])throw new HttpError(400,`${key} 必须是 ${range[0]}–${range[1]} 范围内的整数。`)
 for(const key of ['repository','plannerCli','executorLogin','sourceDirectory','skillsDirectory'])if(typeof value[key]!=='string'||value[key].length>4096||/[\x00-\x1f]/.test(value[key]))throw new HttpError(400,`${key} 必须是有效的文本配置。`)
 if(!/^[a-z0-9-]+$/i.test(value.executorLogin))throw new HttpError(400,'执行账号格式无效。')
 if(value.repository&&!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value.repository))throw new HttpError(400,'仓库请填写 owner/repo。')
 if(value.enabled&&(!value.repository||!value.plannerCli.trim()||!value.sourceDirectory.startsWith('/')||!value.skillsDirectory.startsWith('/')))throw new HttpError(400,'启用前请填写仓库、独立规划账号 CLI、源码绝对目录和完整技能绝对目录。')
 return structuredClone(value)
}

// The settings companion stays mounted while ConfigEditor reloads the automation row.
// This authority-changing operation is user-facing only; no agent write tool is registered.
export class PlannerSettings{
 constructor({editor,entryId,status}){Object.assign(this,{editor,entryId,status})}
 entry(){
  const entry=this.editor.entries().find(e=>e.options.id===this.entryId&&e.options.name==='@local/dsh-issue-planner')
  if(!entry)throw new HttpError(404,'未找到 Issue 定时规划插件，请重新安装或加载插件。')
  return entry
 }
 async read(){
  const raw=structuredClone(this.entry().options.config??{}),value=settingsValue(raw)
  const lockedFields=Object.keys(defaults).filter(key=>object(value[key]))
  return{revision:revision(raw),value,lockedFields,status:await this.status()}
 }
 async save(request){
  if(!object(request)||typeof request.revision!=='string'||Object.keys(request).some(k=>!['revision','value'].includes(k)))throw new HttpError(400,'缺少有效的配置版本。')
  const value=validate(request.value)
  await this.editor.edit(this.entry(),current=>{
   if(revision(current)!==request.revision)throw new HttpError(409,'配置已在其他页面修改，请重新加载后再保存。')
   if(Object.keys(defaults).some(key=>object(current[key])))throw new HttpError(409,'配置含动态表达式，请先在插件配置中处理表达式，再使用此表单。')
   return{...current,...value}
  })
  return this.read()
 }
}
async function body(req){
 if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new HttpError(415,'请使用 JSON 保存设置。')
 const chunks=[];let size=0
 for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=part.length;if(size>16384)throw new HttpError(413,'设置请求过大。');chunks.push(part)}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new HttpError(400,'设置请求不是有效的 JSON。')}
}
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
export function settingsHandler({settings,origin,logger}){
 const port=new URL(origin).port
 return async(req,res)=>{
  const host=req.headers.host
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||req.headers['x-issue-planner-request']!=='1'||req.headers.origin&&req.headers.origin!==`http://${host}`||req.method==='PUT'&&req.headers.origin!==`http://${host}`){json(res,403,{error:'仅允许本机同源的设置请求。'});return}
  if(!['GET','PUT'].includes(req.method)){res.writeHead(405,{Allow:'GET, PUT'});res.end();return}
  try{json(res,200,req.method==='GET'?await settings.read():await settings.save(await body(req)))}
  catch(error){if(error instanceof HttpError)json(res,error.status,{error:error.message});else{logger.error('Issue planner settings: %s',String(error));json(res,503,{error:'无法读取或保存设置，请重新加载后重试。'})}}
 }
}
export function apply(ctx,config){
 const origin=ctx.webServer.getOrigin(),settings=new PlannerSettings({editor:ctx.configEditor,entryId:config.entryId,status:async()=>{
  try{
   const response=await fetch(new URL('/issue-planner/api/status',origin),{headers:{'x-issue-planner-request':'1'},signal:AbortSignal.timeout(2500)})
   if(!response.ok)throw new Error('runtime unavailable')
   const {enabled,phase,error,plannerLogin,nextPollAt,currentIssue}=await response.json()
   return{enabled,phase,error,plannerLogin,nextPollAt,currentIssue}
  }catch{return{phase:'unavailable',enabled:null}}
 }})
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/issue-planner/api/settings',handler:settingsHandler({settings,origin,logger:ctx.logger})}))
}
