// Observations never change the durable publication state or restart an implementation.
export function handoffHealth(record,ticket,config={},now=Date.now()){
 const handoffAt=Date.parse(record.handedOffAt),priorId=record.ticketId??null
 if(!ticket){
  if(priorId)return{ticketId:priorId,executionStatus:'ticket_not_open',lastProgressAt:record.lastProgressAt??null,attentionReason:'ticket_outcome_unobserved'}
  const overdue=Number.isFinite(handoffAt)&&now-handoffAt>=(config.handoffTimeoutMinutes??30)*60000
  return{ticketId:null,executionStatus:overdue?'handoff_unacknowledged':'awaiting_ticket',lastProgressAt:null,attentionReason:overdue?'no_ticket_after_handoff':Number.isFinite(handoffAt)?null:'handoff_time_unknown'}
 }
 const progressAt=Date.parse(ticket.updatedAt),lastProgressAt=Number.isFinite(progressAt)?ticket.updatedAt:record.lastProgressAt??null
 const stale=Number.isFinite(progressAt)&&now-progressAt>=(config.executionStallHours??24)*3600000
 let executionStatus='implementing',attentionReason=Number.isFinite(progressAt)?null:'ticket_progress_time_unknown'
 if(ticket.stage==='person'&&['blocked','failed'].includes(ticket.action)){
  executionStatus=`execution_${ticket.action}`;attentionReason=`worker_reported_${ticket.action}`
 }else if(stale){executionStatus='execution_stalled';attentionReason='no_recent_ticket_progress'}
 else if(ticket.stage==='person'){
  executionStatus=ticket.action==='review'?'awaiting_review':ticket.action==='answer'?'awaiting_answer':'awaiting_person'
  attentionReason='human_action_required'
 }
 return{ticketId:ticket.id,executionStatus,lastProgressAt,attentionReason}
}
