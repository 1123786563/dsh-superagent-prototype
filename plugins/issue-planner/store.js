import { mkdir, readFile, open, rename, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { digest } from './eligibility.js'
export async function openStore(lockRoot, repository, onLost=()=>{}) {
 await mkdir(lockRoot,{recursive:true,mode:0o700})
 const root=join(await realpath(lockRoot),digest(repository.toLowerCase())),owner=randomUUID()
 await mkdir(root,{recursive:true,mode:0o700})
 let lost,closed=false
 const release=await lockfile.lock(root,{retries:0,stale:30000,update:10000,onCompromised(error){lost=error;onLost(error)}})
 const lease=statSync(root+'.lock')
 const assertHeld=()=>{
  if(!lost&&!closed){
   try{const current=statSync(root+'.lock');if(current.ino!==lease.ino||current.birthtimeMs!==lease.birthtimeMs||Date.now()-current.mtimeMs>30000)throw new Error('repository lock replaced or expired')}
   catch(error){lost=error;onLost(error)}
  }
  if(lost||closed)throw new Error('repository lock lost or closed',{cause:lost})
 }
 const close=async()=>{if(closed)return;closed=true;if(!lost)await release()}
 try {
  let data
  try{data=JSON.parse(await readFile(join(root,'records.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  data??={schemaVersion:1,repository:repository.toLowerCase(),records:{}}
  if(data.schemaVersion!==1||!data.records||Array.isArray(data.records)||typeof data.records!=='object'||data.repository!==repository.toLowerCase())throw new Error('unsupported state schema or repository')
  return {data,root,owner,assertHeld,close,async save(){
   assertHeld();const path=join(root,`${owner}.pending.json`),file=await open(path,'w',0o600)
   try{await file.writeFile(JSON.stringify(data,null,2));await file.sync()}finally{await file.close()}
   assertHeld();await rename(path,join(root,'records.json'))
   const directory=await open(root,'r');try{await directory.sync()}finally{await directory.close()}
  }}
 } catch(e){await close();throw e}
}
