import { digest, evaluate, fingerprint, contextFor } from './eligibility.js'
import { publish } from './publisher.js'
import { handoffHealth } from './health.js'
export class Engine {
 constructor({github,store,config,available,plan,signal,now=Date.now}){Object.assign(this,{github,store,config,available,plan,signal,now});this.inFlight=false;this.status={phase:'ready'}}
 async revalidate(record){
  const readiness=await this.available(),snapshot=await this.github.scan(),busy=new Set([...readiness.busyNumbers,...await this.github.busyNumbers()])
  const codeChanged=this.github.defaultCommit&&record.commit!==await this.github.defaultCommit()
  const skillsChanged=this.config.skillDigest&&record.skillDigest!==this.config.skillDigest
  if(codeChanged||skillsChanged||fingerprint(snapshot,record.number)!==record.fingerprint||!evaluate(snapshot,this.config,busy).candidates.some(i=>i.number===record.number)){
   record.state='stale';record.text=null;await this.store.save();throw new Error('plan context changed before publication')
  }
 }
 async tick(){
  if(this.inFlight)return
  this.inFlight=true
  try {
   this.store.assertHeld();const readiness=await this.available()
   let observationsChanged=false
   for(const record of Object.values(this.store.data.records)){
    if(record.state==='handed_off'){
     const observed=handoffHealth(record,readiness.ticketByNumber?.get(record.number),this.config,this.now())
     if(Object.entries(observed).some(([key,value])=>record[key]!==value)){Object.assign(record,observed);observationsChanged=true}
    }else if(!['publishing','publish_uncertain','needs_attention'].includes(record.state)&&!record.text&&record.attempts>=(this.config.maxAttempts??3)){
     record.state='needs_attention';record.attentionReason='planning_attempts_exhausted';observationsChanged=true
    }
   }
   if(observationsChanged)await this.store.save()
   // Reconcile bounded, due records without letting one ambiguous comment starve the queue.
   const unsettled=Object.values(this.store.data.records).filter(r=>['publishing','publish_uncertain'].includes(r.state)&&(!r.reconcileAfter||r.reconcileAfter<=this.now()))
    .sort((a,b)=>(Date.parse(a.lastReconciledAt)||0)-(Date.parse(b.lastReconciledAt)||0)||a.number-b.number).slice(0,5)
   for(const record of unsettled){
    const receiptsBefore=Object.keys(record.receipts??{}).length
    try{await publish({...this,record,revalidate:()=>this.revalidate(record)})}
    catch(error){
     this.store.assertHeld();await this.available()
     if(record.state!=='stale')record.state='publish_uncertain'
     record.error=error.message
    }
    record.lastReconciledAt=new Date(this.now()).toISOString()
    record.reconcileAfter=this.now()+(this.config.reconcileSeconds??300)*1000
    if(record.state==='publish_uncertain'){record.quarantinedAt??=record.lastReconciledAt;record.attentionReason='comment_receipt_uncertain'}
    await this.store.save()
    if(record.state==='handed_off'||Object.keys(record.receipts??{}).length>receiptsBefore){this.status.phase=record.state;return}
   }
   this.status.phase='scanning'
   const snapshot=await this.github.scan(),busy=new Set([...readiness.busyNumbers,...await this.github.busyNumbers()])
   const result=evaluate(snapshot,this.config,busy)
   const skipped=[...result.skipped],runnable=result.candidates.filter(i=>{
    const record=this.store.data.records[i.node_id]
    const reason=record&&(['handed_off','needs_attention','publish_uncertain','publishing'].includes(record.state)?`planner state: ${record.state}`:record.retryAt&&this.now()<record.retryAt?`planning retry cooldown until ${new Date(record.retryAt).toISOString()}`:null)
    if(reason){skipped.push({number:i.number,reason});return false}
    return true
   })
   this.status={phase:'ready',lastScan:new Date(this.now()).toISOString(),totalOpen:snapshot.issues.filter(i=>i.state==='open').length,candidates:runnable.map(i=>i.number),skipped}
   const issue=runnable[0]
   if(!issue)return
   const hash=fingerprint(snapshot,issue.number)
   let record=this.store.data.records[issue.node_id]
   if(!record||record.fingerprint!==hash){record={number:issue.number,nodeId:issue.node_id,key:digest([this.config.repository.toLowerCase(),issue.node_id,hash]),fingerprint:hash,state:'claimed',attempts:record?.attempts??0,parts:[],owner:this.store.owner};this.store.data.records[issue.node_id]=record;await this.store.save()}
   this.status.currentIssue=issue.number
   try{
    if(!record.text){
     if(record.attempts>=(this.config.maxAttempts??3)){
      record.state='needs_attention';record.attentionReason='planning_attempts_exhausted';await this.store.save();this.status.phase=record.state;return
     }
     record.state='planning';record.attempts++;record.attemptStartedAt=new Date(this.now()).toISOString();await this.store.save();this.status.phase='planning'
     const output=await this.plan({snapshot,chain:contextFor(snapshot,issue.number),record,signal:this.signal})
     this.store.assertHeld();await this.available()
     if(!output.text?.trim())throw new Error('planner did not submit a complete plan')
     Object.assign(record,output,{state:'planned',key:digest([this.config.repository.toLowerCase(),issue.node_id,hash,output.commit,output.skillDigest,digest(output.text)]),receipts:{},parts:[],pending:null});await this.store.save()
    }
    // A fresh full graph also rechecks root, dependencies, comments and active implementation.
    const fresh=await this.github.scan(),currentReady=await this.available(),currentBusy=new Set([...currentReady.busyNumbers,...await this.github.busyNumbers()])
    if(fingerprint(fresh,issue.number)!==hash||!evaluate(fresh,this.config,currentBusy).candidates.some(i=>i.number===issue.number)){
     record.state='stale';record.text=null;await this.store.save();this.status.phase='stale';return
    }
    await publish({...this,record,revalidate:()=>this.revalidate(record)})
    if(record.state==='publish_uncertain'){
     record.quarantinedAt??=new Date(this.now()).toISOString();record.attentionReason='comment_receipt_uncertain';record.reconcileAfter=this.now()+(this.config.reconcileSeconds??300)*1000;await this.store.save()
    }
    this.status.phase=record.state
   } catch(error){
    if(!['publishing','publish_uncertain','handed_off'].includes(record.state)){
     record.state=record.attempts>=(this.config.maxAttempts??3)?'needs_attention':'retry_wait'
     record.retryAt=this.now()+Math.min(3600000,60000*2**record.attempts)
     record.attentionReason=record.state==='needs_attention'?'planning_attempts_exhausted':null
    }
    record.error=error.message;await this.store.save();this.status.phase=record.state;this.status.error=error.message
   }
  }catch(error){this.status.phase='not_ready';this.status.error=error.message}
  finally{this.inFlight=false}
 }
}
