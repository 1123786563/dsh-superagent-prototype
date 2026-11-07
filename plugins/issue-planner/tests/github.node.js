import test from 'node:test'
import assert from 'node:assert/strict'
import { Github } from '../github.js'
test('pages read beyond 100 and exclude PRs from scan input',async()=>{
 const gh=new Github({repository:'owner/repo',cli:'unused'})
 gh.api=async path=>/[?&]page=1(?:&|$)/.test(path)?Array.from({length:100},(_,i)=>({number:i+1})): [{number:101}]
 assert.equal((await gh.pages('items')).length,101)
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
