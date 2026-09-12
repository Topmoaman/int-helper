import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createVirtualSchoolAdapter } from '../src/web-adapters/virtual-school.mjs';
const origin='https://main.virtualschool.club';
const scope={origin,subjectCode:'59',level:'J',term:'1',year:'2569',mode:'final',retryUntilPerfect:true,
 virtualActivity:{kind:'exam',examType:'F',attemptId:'test-attempt',totalQuestions:50,enteredAt:1}};
const location={hostname:'main.virtualschool.club',pathname:'/Exam',href:origin+'/Exam?subject=59&level=J&term=1&year=2569&examtype=F'};
const state={number:35,blocked:true,missing:false,checked:0,selectedClicks:0,nextClicks:0};
const elem=innerText=>({innerText,getClientRects:()=>[1],querySelector:()=>null});
const radios=[1,2].map(index=>({nextElementSibling:elem('Choice '+index),get checked(){return state.checked===index},
 click(){state.checked=index;state.selectedClicks++}}));
const button={...elem('ข้อถัดไป'),get disabled(){return state.blocked},click(){state.nextClicks++;state.number++;state.checked=0}};
const document={get body(){return elem('รหัสข้อสอบ : TESTCODE ทั้งหมด 50 ข้อ')},
 querySelector(selector){if(selector==='main img[src*="/question_pic/"]' && state.number===37)return {src:origin+'/question_pic/fixture-recovery-question.jpg'};if(selector==='main h2')return elem('ข้อคำถามที่ '+state.number);if(selector==='.exam-question')return elem('Question '+state.number);return null},
 querySelectorAll(selector){if(selector==='main input[type="radio"]')return radios;if(selector==='main button')return state.missing?[]:[button];return []}};
const adapter=createVirtualSchoolAdapter({document,location});
const page=(action,payload={})=>adapter.handle(action,{scope,...payload});
for(const missing of [false,true]){
 state.missing=missing;
 const r=page('navigate_next',{expectedExamCode:'TESTCODE:35'});
 assert.equal(r.done,false,'missing/disabled Next at 35/50 is not completion');
 assert.equal(r.navigationPending,true);assert.equal(state.nextClicks,0);
}
state.number=50;
assert.equal(page('navigate_next',{expectedExamCode:'TESTCODE:50'}).done,true,'last question uses observed total');
state.number=35;state.missing=false;
let imageFails=true,imageFetches=0;
let api;const storage={};
class Socket{static OPEN=1;readyState=1;send(){}close(){this.readyState=3}}
const chrome={storage:{session:{get:async key=>key===null?storage:{[key]:storage[key]},set:async value=>Object.assign(storage,structuredClone(value)),remove:async key=>delete storage[key]}},
 action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(){}},runtime:{getManifest:()=>({version:'test'}),onMessage:{addListener(){}}},
 tabs:{query:async()=>[{id:7,active:true,url:location.href}],sendMessage:async(_,m)=>{
  if(m.action==='page_version')return {ok:true,result:{contentVersion:'test',pageInstanceId:'page',url:location.href}};
  if(m.action==='submit_exam')throw Error('Incomplete exam must not dispatch submission');
  try{return {ok:true,result:page(m.action,m)}}catch(error){return {ok:false,error:error.message}}
 }}};
runInNewContext(readFileSync(new URL('../extension/service-worker.js',import.meta.url),'utf8')+'\nexpose({handleBridgeRequest,sessions});',{
 chrome,WebSocket:Socket,URL,URLSearchParams,crypto:{randomUUID},Date,console,
 fetch:async()=>{imageFetches++;return {ok:!imageFails,status:imageFails?403:200,headers:{get:()=> 'image/jpeg'},arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer}},
 btoa:value=>Buffer.from(value,'binary').toString('base64'),setInterval(){},clearTimeout(){},
 setTimeout(f,ms){if(ms<1000)queueMicrotask(f);return 1},expose(value){api=value}});
const session={scope,port:17373,tabId:7,attemptAnswers:new Map(),rejectedQuestions:new Set()};
api.sessions.set(17373,session);
const call=(action,payload={})=>api.handleBridgeRequest(action,payload,17373,true);
let r=await call('answer_and_next',{examCode:'TESTCODE:35',choiceIndex:1,save:false});
assert.equal(r.done,false);assert.equal(r.navigationPending,true);assert.equal(r.questionNumber,35);
assert.equal(state.selectedClicks,1);assert.equal(session.recoveryPending,null);
// A validation-only incomplete submission is recoverable and dispatches no click.
r=await call('submit_current_exam',{examCode:'TESTCODE:35'});
assert.equal(r.mode,'exam_incomplete');assert.equal(r.submissionApplied,false);
assert.equal(session.recoveryPending,null);
state.blocked=false;
r=await call('answer_and_next',{examCode:'TESTCODE:35',choiceIndex:1,save:false});
assert.equal(r.questionNumber,36);assert.equal(r.done,false);
assert.equal(state.selectedClicks,1,'retry advances the verified selection without clicking the answer again');
assert.equal(state.nextClicks,1);assert.equal(session.attemptAnswers.size,1);
console.log('Virtual navigation recovery passed: 35/50 disabled/missing Next, actual final, incomplete submission, idempotent navigation retry');

// Image transport failure after a confirmed answer/navigation is not an uncertain mutation.
const beforeImages=state.selectedClicks;
r=await call('answer_and_next',{examCode:'TESTCODE:36',choiceIndex:1,save:false});
assert.equal(state.number,37);assert.equal(r.answeredExamCode,'TESTCODE:36');
assert.equal(r.imagesPending,true);assert.equal(r.questionNumber,37);assert.match(r.imageWarning,/403/);
assert.equal(session.recoveryPending,null);assert.equal(session.attemptAnswers.size,2);
assert.equal(imageFetches,1,'no automatic image retry or new delay on every question');
assert.equal(state.selectedClicks,beforeImages+1);
const pendingToken=r.resumeToken;
api.sessions.delete(17373);
r=await call('resume_scope',{resumeToken:pendingToken});assert.equal(r.restoredAnswerCount,2);
// Failed reads and attempts to answer while an image is unavailable do not click.
r=await call('read_current_question');assert.equal(r.imagesPending,true);
r=await call('answer_and_next',{examCode:'TESTCODE:37',choiceIndex:1,save:false});
assert.equal(r.answerApplied,false);assert.equal(state.number,37);assert.equal(state.selectedClicks,beforeImages+1);
imageFails=false;
r=await call('read_current_question');assert.equal(r.imagesPending,undefined);assert.equal(r.images.length,1);
r=await call('answer_and_next',{examCode:'TESTCODE:37',choiceIndex:1,save:false});
assert.equal(r.questionNumber,38);assert.equal(state.selectedClicks,beforeImages+2);assert.equal(r.recoveryWarning,undefined);
assert.equal(api.sessions.get(17373).recoveryPending,null);
console.log('Image recovery passed: 403 after navigation, checkpoint/resume, blocked unreadable answer, successful read and continued answer with no replay');
