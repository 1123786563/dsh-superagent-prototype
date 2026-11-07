import { digest, evaluate, fingerprint, contextFor } from './eligibility.js'
import { publish } from './publisher.js'
export class Engine {
 constructor({github,store,config,available,plan,signal}){Object.assign(this,{github,store,config,available,plan,signal});this.inFlight=false;this.status={phase:'ready'}}
 async revalidate(record){
  const readiness=await this.available(),snapshot=await this.github.scan(),busy=new Set([...readiness.busyNumbers,...await this.github.busyNumbers()])
  if(fingerprint(snapshot,record.number)!==record.fingerprint||!evaluate(snapshot,this.config,busy).candidates.some(i=>i.number===record.number)){
   record.state='stale';record.text=null;await this.store.save();throw new Error('plan context changed before publication')
  }
 }
 async tick(){
  if(this.inFlight)return
  this.inFlight=true
  try {
   this.store.assertHeld();const readiness=await this.available()
   // An outbound intent is always reconciled first, including after a process crash.
   const unsettled=Object.values(this.store.data.records).find(r=>['publishing','publish_uncertain'].includes(r.state))
   if(unsettled){await publish({...this,record:unsettled,revalidate:()=>this.revalidate(unsettled)});this.status.phase=unsettled.state;return}
   this.status.phase='scanning'
   const snapshot=await this.github.scan(),busy=new Set([...readiness.busyNumbers,...await this.github.busyNumbers()])
   const result=evaluate(snapshot,this.config,busy)
   this.status={phase:'ready',lastScan:new Date().toISOString(),totalOpen:snapshot.issues.filter(i=>i.state==='open').length,candidates:result.candidates.map(i=>i.number),skipped:result.skipped}
   const issue=result.candidates.find(i=>{
    const r=this.store.data.records[i.node_id];return !r||!['handed_off','needs_attention','publish_uncertain'].includes(r.state)&&(!r.retryAt||Date.now()>=r.retryAt)
   })
   if(!issue)return
   const hash=fingerprint(snapshot,issue.number)
   let record=this.store.data.records[issue.node_id]
   if(!record||record.fingerprint!==hash){record={number:issue.number,nodeId:issue.node_id,key:digest([this.config.repository.toLowerCase(),issue.node_id,hash]),fingerprint:hash,state:'claimed',attempts:0,parts:[],owner:this.store.owner};this.store.data.records[issue.node_id]=record;await this.store.save()}
   this.status.currentIssue=issue.number
   try{
    if(!record.text){
     record.state='planning';record.attempts++;await this.store.save();this.status.phase='planning'
     const output=await this.plan({snapshot,chain:contextFor(snapshot,issue.number),record,signal:this.signal})
     this.store.assertHeld();await this.available()
     if(!output.text?.trim())throw new Error('planner did not submit a complete plan')
     Object.assign(record,output,{state:'planned'});await this.store.save()
    }
    // A fresh full graph also rechecks root, dependencies, comments and active implementation.
    const fresh=await this.github.scan(),currentReady=await this.available(),currentBusy=new Set([...currentReady.busyNumbers,...await this.github.busyNumbers()])
    if(fingerprint(fresh,issue.number)!==hash||!evaluate(fresh,this.config,currentBusy).candidates.some(i=>i.number===issue.number)){
     record.state='stale';record.text=null;await this.store.save();this.status.phase='stale';return
    }
    await publish({...this,record,revalidate:()=>this.revalidate(record)})
    this.status.phase=record.state
   } catch(error){
    if(!['publishing','publish_uncertain','handed_off'].includes(record.state)){
     record.state=record.attempts>=(this.config.maxAttempts??3)?'needs_attention':'retry_wait'
     record.retryAt=Date.now()+Math.min(3600000,60000*2**record.attempts)
    }
    record.error=error.message;await this.store.save();throw error
   }
  }catch(error){this.status.phase='not_ready';this.status.error=error.message}
  finally{this.inFlight=false}
 }
}
