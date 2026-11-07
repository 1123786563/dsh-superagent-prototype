import test from 'node:test'
import assert from 'node:assert/strict'
import { handoffHealth } from '../health.js'
const now=Date.parse('2026-11-07T12:00:00Z'),ago=minutes=>new Date(now-minutes*60000).toISOString()
const record={state:'handed_off',handedOffAt:ago(60)}
test('unacknowledged handoff is flagged without reissuing the implementation',()=>{
 assert.equal(handoffHealth(record,null,{},now).executionStatus,'handoff_unacknowledged')
 assert.equal(handoffHealth({...record,handedOffAt:ago(5)},null,{},now).executionStatus,'awaiting_ticket')
 assert.equal(record.state,'handed_off')
})
test('explicitly blocked or failed execution is flagged immediately',()=>{
 for(const action of ['blocked','failed']){
  const result=handoffHealth(record,{id:'ticket',stage:'person',action,updatedAt:ago(1)},{},now)
  assert.equal(result.executionStatus,`execution_${action}`);assert.equal(result.ticketId,'ticket')
 }
})
test('only lack of authoritative ticket progress reaches the stall threshold',()=>{
 assert.equal(handoffHealth(record,{id:'ticket',stage:'working',updatedAt:ago(24*60+1)},{},now).executionStatus,'execution_stalled')
 assert.equal(handoffHealth(record,{id:'ticket',stage:'working',updatedAt:ago(5)},{},now).executionStatus,'implementing')
 assert.equal(handoffHealth(record,{id:'ticket',stage:'person',action:'review',updatedAt:ago(5)},{},now).executionStatus,'awaiting_review')
 assert.equal(handoffHealth(record,{id:'ticket',stage:'person',action:'answer',updatedAt:ago(5)},{},now).executionStatus,'awaiting_answer')
})
test('a ticket leaving the open inventory is not treated as proof of completion',()=>{
 assert.equal(handoffHealth({...record,ticketId:'old-ticket'},null,{},now).executionStatus,'ticket_not_open')
 const unknown=handoffHealth({state:'handed_off'},null,{},now)
 assert.equal(unknown.executionStatus,'awaiting_ticket');assert.equal(unknown.attentionReason,'handoff_time_unknown')
})
