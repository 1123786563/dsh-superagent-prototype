import test from 'node:test'
import assert from 'node:assert/strict'
import { Github } from '../github.js'
test('pages read beyond 100 and exclude PRs from scan input',async()=>{
 const gh=new Github({repository:'owner/repo',cli:'unused'})
 gh.api=async path=>/[?&]page=1(?:&|$)/.test(path)?Array.from({length:100},(_,i)=>({number:i+1})): [{number:101}]
 assert.equal((await gh.pages('items')).length,101)
})
test('scan hydrates all pages, excludes PRs and resolves closed referenced dependencies',async()=>{
 const gh=new Github({repository:'owner/repo',cli:'unused'})
 gh.pages=async()=>[...Array.from({length:101},(_,i)=>({number:i+1,node_id:`I${i+1}`,state:'open',body:i===0?'## Blocked by\n#200':'',comments:0})),{number:300,pull_request:{}}]
 gh.relations=async number=>({parent:null,children:[],dependencies:[]})
 gh.comments=async()=>[]
 gh.api=async()=>({number:200,node_id:'I200',state:'closed',state_reason:'completed',comments:0})
 const result=await gh.scan()
 assert.equal(result.issues.length,102);assert.ok(!result.issues.some(i=>i.number===300));assert.ok(result.issues.some(i=>i.number===200))
})
test('bounded pagination throws instead of accepting a partial list',async()=>{
 const gh=new Github({repository:'owner/repo',cli:'unused'});gh.api=async()=>Array.from({length:100},()=>({}))
 await assert.rejects(gh.pages('items',2),/pagination/)
})
test('graphql errors and foreign repository relationships fail closed',async()=>{
 const gh=new Github({repository:'owner/repo',cli:'unused'})
 gh.api=async()=>({errors:[{message:'forbidden'}]})
 await assert.rejects(gh.relations(1),/GraphQL/)
 gh.api=async()=>({data:{repository:{issue:{parent:{number:1,repository:{nameWithOwner:'other/repo'}},subIssues:{nodes:[],pageInfo:{hasNextPage:false}},blockedBy:{nodes:[],pageInfo:{hasNextPage:false}}}}}})
 await assert.rejects(gh.relations(2),/repository/)
})
