import { execFile } from 'node:child_process'
export function command(file,args,{signal,input,maxBuffer=16*1024*1024,cwd}={}) {
 return new Promise((resolve,reject)=>{
  const child=execFile(file,args,{cwd,encoding:'utf8',timeout:60000,maxBuffer,signal,env:{...process.env,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'}},(error,stdout,stderr)=>{
   if(error)reject(Object.assign(new Error(`${file}: ${stderr.slice(-1200)||error.message}`),{cause:error}));else resolve(stdout)
  })
  child.stdin.on('error',reject);child.stdin.end(input)
 })
}
export class Github {
 constructor(config,signal){this.config=config;this.signal=signal}
 repo(path){return `repos/${this.config.repository}/${path}`}
 async api(path,input){
  const args=['api','--hostname','github.com',path,'-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28']
  if(input!==undefined)args.push('--method','POST','--input','-')
  return JSON.parse(await command(this.config.cli,args,{signal:this.signal,input:input===undefined?undefined:JSON.stringify(input)}))
 }
 async pages(path,maxPages=100){
  const items=[]
  for(let page=1;page<=maxPages;page++){
   const data=await this.api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`)
   if(!Array.isArray(data))throw new Error('invalid pagination response')
   items.push(...data);if(data.length<100)return items
  }
  throw new Error('pagination limit reached; snapshot incomplete')
 }
 comments(number){return this.pages(this.repo(`issues/${number}/comments`))}
 async graph(query,variables){const result=await this.api('graphql',{query,variables});if(result.errors||!result.data)throw new Error('GraphQL incomplete: '+JSON.stringify(result.errors));return result.data}
 async relations(number){
  const [owner,name]=this.config.repository.split('/'), all={parent:null,children:[],dependencies:[]}
  const cursors={subIssues:null,blockedBy:null},done=new Set()
  for(let page=0;page<100;page++){
   const fields=['subIssues','blockedBy'].filter(f=>!done.has(f))
   const declarations=fields.map(f=>`$${f}Cursor:String`).join(',')
   const selection=fields.map(f=>`${f}(first:100,after:$${f}Cursor){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}`).join(' ')
   const variables={owner,name,number,...Object.fromEntries(fields.map(f=>[`${f}Cursor`,cursors[f]]))}
   const data=await this.graph(`query($owner:String!,$name:String!,$number:Int!,${declarations}){repository(owner:$owner,name:$name){issue(number:$number){parent{number repository{nameWithOwner}} ${selection}}}}`,variables)
   const issue=data.repository?.issue;if(!issue)throw new Error(`unreadable issue #${number}`)
   all.parent=issue.parent?.number??null
   for(const field of fields){
    const items=issue[field];if(!items?.nodes||!items.pageInfo)throw new Error('incomplete relations')
    for(const ref of [issue.parent,...items.nodes].filter(Boolean))if(ref.repository?.nameWithOwner?.toLowerCase()!==this.config.repository.toLowerCase())throw new Error('cross repository relationship requires manual attention')
    all[field==='subIssues'?'children':'dependencies'].push(...items.nodes.map(n=>n.number))
    if(!items.pageInfo.hasNextPage)done.add(field)
    else {if(!items.pageInfo.endCursor||items.pageInfo.endCursor===cursors[field])throw new Error('relation pagination incomplete');cursors[field]=items.pageInfo.endCursor}
   }
   if(done.size===2)return all
  }
  throw new Error('relation pagination incomplete')
 }
 async defaultCommit(){
  const meta=await this.api(this.repo('')),head=await this.api(this.repo(`commits/${encodeURIComponent(meta.default_branch)}`))
  if(!/^[0-9a-f]{40,64}$/.test(head.sha))throw new Error('invalid default branch commit')
  return head.sha
 }
 async scan(){
  const initial=(await this.pages(this.repo('issues?state=open&sort=created&direction=asc'))).filter(i=>!i.pull_request)
  const issues=new Map(),queue=initial.map(i=>i.number), raw=new Map(initial.map(i=>[i.number,i])),scheduled=new Set(queue)
  while(queue.length){
   await Promise.all(queue.splice(0,4).map(async number=>{
    if(issues.size>=5000)throw new Error('issue graph exceeds 5000; snapshot incomplete')
    const issue=raw.get(number)??await this.api(this.repo(`issues/${number}`))
    if(issue.pull_request)throw new Error('issue relation points to a pull request')
    const relations=await this.relations(number),comments=issue.comments===0?[]:await this.comments(number)
    issues.set(number,{...issue,...relations,comments})
    // Explicit markdown links in body sections can point to closed ancestors/dependencies.
    const sections=[...String(issue.body??'').matchAll(/^#{1,6}\s+(?:Parent|父 Issue|父任务|Blocked by|Depends on|依赖|阻塞依赖)\s*:?\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/gim)].map(m=>m[1]).join('\n')
    for(const n of [relations.parent,...relations.children,...relations.dependencies,...[...sections.matchAll(/#(\d+)\b/g)].map(m=>Number(m[1]))].filter(Boolean))if(!scheduled.has(n)){scheduled.add(n);queue.push(n)}
   }))
  }
  return {issues:[...issues.values()]}
 }
 async busyNumbers(){
  const pulls=await this.pages(this.repo('pulls?state=open')),busy=new Set(),[owner,name]=this.config.repository.split('/')
  for(const pr of pulls){
   let cursor=null
   for(let page=0;page<100;page++){
    const data=await this.graph('query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}',{owner,name,number:pr.number,cursor})
    const refs=data.repository?.pullRequest?.closingIssuesReferences;if(!refs)throw new Error('unreadable PR issue references')
    for(const ref of refs.nodes)if(ref.repository.nameWithOwner.toLowerCase()===this.config.repository.toLowerCase())busy.add(ref.number)
    if(!refs.pageInfo.hasNextPage)break
    if(!refs.pageInfo.endCursor||refs.pageInfo.endCursor===cursor||page===99)throw new Error('PR references incomplete')
    cursor=refs.pageInfo.endCursor
   }
  }
  return busy
 }
 postComment(number,body){return this.api(this.repo(`issues/${number}/comments`),{body})}
}
