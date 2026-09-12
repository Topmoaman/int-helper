import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
const source=readFileSync(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const storage={};
const storageClone=value=>Array.isArray(value)?value.map(storageClone):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,storageClone(value[k])])):value;
let storageFails=false, now=1000000, applyHook=null;
const origin='https://main.virtualschool.club';
const state={path:'/StudyCourse',instance:'page-1',n:1,submitted:false,total:50,tab:7};
const effects=[];
const question=()=>({examCode:`EXAM:${state.n}`,questionNumber:state.n,totalQuestions:state.total,
 questionText:`Question ${state.n}`,questionImage:null,choices:[{index:1,text:`A${state.n}`},{index:2,text:`B${state.n}`}],done:false});
const reviews=()=>Array.from({length:state.total},(_,i)=>({examCode:null,questionNumber:i+1,questionText:`Question ${i+1}`,questionImage:null,
 choices:[{index:1,text:`A${i+1}`},{index:2,text:`B${i+1}`}],correctChoiceIndex:i===1?2:1,selectedChoiceIndex:1,
 selectionState:'selected',correctness:i===1?'incorrect':'correct',verificationSource:'Virtual School explicit correct-answer label'}));
const boot=()=>{
 let api; const sockets=[];
 class Socket {static OPEN=1;readyState=1;constructor(){sockets.push(this)} send(){} close(){this.readyState=3;this.onclose?.()}}
 const chrome={storage:{session:{get:async key=>storageClone(key===null?storage:{[key]:storage[key]}),set:async record=>{
  if(storageFails)throw Error('storage unavailable');Object.assign(storage,storageClone(record));
 },remove:async key=>{delete storage[key]}}},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(){}},runtime:{getManifest:()=>({version:'test'}),onMessage:{addListener(){}}},
 tabs:{query:async()=>[{id:state.tab,active:true,url:origin+state.path}],sendMessage:async(tab,m)=>{
  assert.equal(tab,state.tab,'never resume another tab');let result;
  if(m.action==='page_version')result={contentVersion:'test',pageInstanceId:state.instance,url:origin+state.path};
  else if(m.action==='inspect_page')result={origin,path:state.path,course:{subjectCode:'BIO',subjectName:'Biology',level:'6',term:'1',year:'2026'},chapters:[]};
  else if(m.action==='read_question'){
   if(state.path!=='/Exam'||state.submitted)return {ok:false,error:'Not an active question'};
   result=question();
  }else if(m.action==='advance_subject'){
   if(state.path==='/Exam')return {ok:true,result:{ok:true,mode:'exam',needsAnswers:true}};
   effects.push(m.action);state.path='/Exam';state.n=1;state.submitted=false;
   result={virtualFinalOpened:true,virtualAttemptId:m.virtualAttemptId,virtualAttemptEnteredAt:m.virtualAttemptEnteredAt,done:false};
  }else if(m.action==='apply_answer'){
   effects.push(m.action);if(applyHook)await applyHook();result={examCode:question().examCode,selected:1,saved:null};
  }else if(m.action==='navigate_next'){
   effects.push(m.action);result={done:state.n===state.total};if(!result.done)state.n++;
  }else if(m.action==='read_submission_status')result={submitted:state.submitted,marker:state.submitted?'submitted':null};
  else if(m.action==='submit_exam'){effects.push(m.action);state.submitted=true;result={action:'confirmed'};}
  else if(m.action==='read_exam_result')result={ok:true,url:origin+state.path,resultToken:state.path,score:{correct:state.total-1,total:state.total},choices:[],
   ...(state.path==='/Exam'?{submittedMarker:'submitted'}:{reviewLayout:'all',ready:true,reviewComplete:true,totalQuestions:state.total,examCode:null,verifiedReviews:reviews()})};
  else if(m.action==='open_answer_review'){effects.push(m.action);state.path=m.step==='return'?'/StudyCourse':'/AllExamAnswers';result={ok:true,action:m.step==='return'?'returned':'opened_review',done:false};}
  else throw Error('Unexpected '+m.action);
  return {ok:true,result};
 }}};
 runInNewContext(source+'\nexpose({handleBridgeRequest,sessions,saveCheckpoint,connectedPorts,heartbeats,connect});',{
 chrome,URL,WebSocket:Socket,crypto:{randomUUID},Date:class extends Date { static now(){return now} },console,
 setInterval(){},setTimeout:(f,ms)=>{if(ms<1000){now+=ms;queueMicrotask(f)}return 1},clearTimeout(){},
 expose:x=>api=x,
 });
 return {...api,sockets,call:(action,payload={},port=17373,history=true)=>api.handleBridgeRequest(action,payload,port,history)};
};
let a=boot();
let r=await a.call('set_scope',{subjectCode:'BIO',mode:'final',retryUntilPerfect:true});
const token=r.resumeToken;assert.match(token,/^[a-f0-9-]{36}$/);
await a.call('set_exam_pacing',{durationMinutes:60});
await a.call('advance_subject');
// Pacing must remain anchored after reconnect, without advancing a question.
const enteredAt=a.sessions.get(17373).scope.virtualActivity.enteredAt;
await a.call('answer_and_next',{examCode:'EXAM:1',choiceIndex:1,save:false});
a.sockets[0].close();assert.equal(a.sessions.has(17373),false);
const before=effects.length;
r=await a.call('resume_scope',{resumeToken:token},17374);
assert.equal(effects.length,before,'resume performs no website mutations');
assert.equal(r.loopMode,'loop_until_full');assert.equal(r.restoredAnswerCount,1);assert.equal(r.scope.durationMinutes,60);
assert.equal(r.scope.virtualActivity.enteredAt,enteredAt);
assert.equal((await a.call('answer_and_next',{examCode:'EXAM:2',choiceIndex:1},17374)).mode,'pacing');
// A worker restart also restores Maps/Sets and the exact original attempt id.
a=boot();r=await a.call('resume_scope',{resumeToken:token});
assert.equal(r.restoredAnswerCount,1);
await assert.rejects(a.call('set_current_exam_scope',{examCode:'EXAM:2',allowSubmit:true}),/existing final\/Loop scope/);
now=enteredAt+3600001;
for(const n of Array.from({length:49},(_,i)=>i+2))await a.call('answer_and_next',{examCode:`EXAM:${n}`,choiceIndex:1});
// Reconnect immediately before the approved submission, then after confirmation.
a.sockets[0].close();a=boot();r=await a.call('resume_scope',{resumeToken:token});
assert.equal(r.restoredAnswerCount,50);assert.equal(r.scope.mode,'final');
await a.call('submit_current_exam',{examCode:'EXAM:50'});
a.sockets[0].close();a=boot();await a.call('resume_scope',{resumeToken:token});
await a.call('read_exam_result');
r=await a.call('open_answer_review',{resultToken:'/Exam',step:'open'});
assert.equal(r.reviewBound,true);assert.equal(r.reviewPlan.done,true);assert.equal(r.rejectedReviews.length,1);
assert.equal(effects.filter(x=>x==='submit_exam').length,1,'submission is never replayed by restoration');
a.sockets[0].close();a=boot();r=await a.call('resume_scope',{resumeToken:token});
assert.equal(r.scope.virtualActivity.reviewBound,true);assert.equal(r.submitted,true);
assert.equal(r.historyEnabled,true);
// The actual return response has navigation metadata, not question choices.
const firstAttempt=a.sessions.get(17373).scope.virtualActivity.attemptId;
r=await a.call('open_answer_review',{resultToken:'/AllExamAnswers',step:'sheet',readAfter:false});
assert.equal(r.choices,undefined);assert.equal(r.recoveryWarning,undefined);
assert.equal(a.sessions.get(17373).recoveryPending,null);
r=await a.call('open_answer_review',{resultToken:'/AllExamAnswers',step:'return'});
assert.equal(r.action,'returned');assert.equal(r.choices,undefined);
assert.equal(r.recoveryWarning,undefined);assert.equal(a.sessions.get(17373).recoveryPending,null);
assert.equal(state.path,'/StudyCourse');assert.equal(a.sessions.get(17373).attemptAnswers.size,50);
a.sockets[0].close();a=boot();r=await a.call('resume_scope',{resumeToken:token});
assert.equal(r.restoredAnswerCount,50);assert.equal(r.scope.virtualActivity.reviewBound,true);
await a.call('complete_current_lesson');
assert.equal(state.path,'/Exam');assert.equal(state.n,1);
assert.equal(a.sessions.get(17373).attemptAnswers.size,0);
assert.notEqual(a.sessions.get(17373).scope.virtualActivity.attemptId,firstAttempt);
assert.equal(a.sessions.get(17373).scope.retryUntilPerfect,true);
assert.equal(effects.filter(x=>x==='submit_exam').length,1,'return and retry never resubmit the previous attempt');
// Stolen/incorrect tokens, changed pages, changed question and active owners fail.
await assert.rejects(a.call('resume_scope',{resumeToken:randomUUID()},17374),/missing or expired/);
a.heartbeats.set(17373,now);await assert.rejects(a.call('resume_scope',{resumeToken:token},17374),/still active/);
a.sockets[0].close();state.instance='reloaded';
await assert.rejects(a.call('resume_scope',{resumeToken:token},17374),/same tab/);state.instance='page-1';
const saved=Object.values(storage).find(x=>x.resumeToken===token);
saved.pendingAction='submit_current_exam';
a=boot();r=await a.call('resume_scope',{resumeToken:token});assert.equal(r.recoveryPending,'submit_current_exam');
await assert.rejects(a.call('submit_current_exam',{examCode:'EXAM:50'}),/uncertain outcome/);
// Missing legacy checkpoints do not silently downgrade a saved final.
a=boot();await assert.rejects(a.call('set_current_exam_scope',{examCode:'EXAM:50',allowSubmit:true}),/saved final scope/);
// A new Normal manual workflow remains manual and history-off after recovery.
state.path='/StudyCourse';state.instance='normal-page';state.submitted=false;
a=boot();r=await a.call('set_scope',{subjectCode:'BIO',mode:'final',autoSubmit:false},17373,false);
const normalToken=r.resumeToken;
await a.call('advance_subject',{},17373,false);
a.sockets[0].close();a=boot();r=await a.call('resume_scope',{resumeToken:normalToken});
assert.equal(r.loopMode,'normal');assert.equal(r.historyEnabled,false);assert.equal(r.scope.autoSubmit,false);
const clicks=effects.length;r=await a.call('submit_current_exam',{examCode:'EXAM:1'},17373,false);
assert.equal(r.mode,'awaiting_user_submission');assert.equal(effects.length,clicks);
// Storage failure before a side effect blocks the action; cannot falsely report a saved checkpoint.
storageFails=true;await assert.rejects(a.call('answer_and_next',{examCode:'EXAM:1',choiceIndex:1},17373,false),/storage unavailable/);
assert.equal(effects.length,clicks);storageFails=false;
// A disconnect during an answer waits for the actual command to checkpoint.
let releaseAnswer, signalAnswer;
const answerStarted=new Promise(resolve=>{signalAnswer=resolve});
const answerReleased=new Promise(resolve=>{releaseAnswer=resolve});
applyHook=async()=>{signalAnswer();await answerReleased};
const inFlight=a.call('answer_and_next',{examCode:'EXAM:1',choiceIndex:1},17373,false);
await answerStarted;a.sockets[0].close();
assert.equal(a.sessions.has(17373),true,'do not detach a running answer');
await assert.rejects(a.call('resume_scope',{resumeToken:normalToken},17374),/still active/);
releaseAnswer();await inFlight;applyHook=null;
assert.equal(a.sessions.has(17373),false);
r=await a.call('resume_scope',{resumeToken:normalToken},17374);
assert.equal(r.restoredAnswerCount,1);assert.equal(state.n,2);
// Concurrent restore calls cannot acquire the same checkpoint twice.
a.sockets[1].close();a=boot();
const concurrent=await Promise.allSettled([
 a.call('resume_scope',{resumeToken:normalToken}),
 a.call('resume_scope',{resumeToken:normalToken},17374),
]);
assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
assert.match(concurrent.find(x=>x.status==='rejected').reason.message,/already being restored/);
// A connected owner is protected even before its first heartbeat.
await assert.rejects(a.call('resume_scope',{resumeToken:normalToken},17374),/still active/);
// An old socket's close callback must not detach its replacement's session.
const staleSocket=a.sockets[0];a.connect(17373);staleSocket.close();
assert.equal(a.sessions.has(17373),true);
// If the website succeeds but the final checkpoint fails, the live connection
// must also refuse another mutation; never rely only on a textual warning.
applyHook=async()=>{storageFails=true};
r=await a.call('answer_and_next',{examCode:'EXAM:2',choiceIndex:1},17373,false);
applyHook=null;storageFails=false;
assert.match(r.recoveryWarning,/checkpoint failed/);assert.equal(state.n,3);
const afterFailure=effects.length;
await assert.rejects(a.call('answer_and_next',{examCode:'EXAM:3',choiceIndex:1}),/uncertain outcome/);
assert.equal(effects.length,afterFailure);
now+=24*60*60*1000+1;a.sockets[0].close();a=boot();
await assert.rejects(a.call('resume_scope',{resumeToken:normalToken}),/expired/);
// Starting a new scope prunes expired browser-session checkpoints.
state.path='/StudyCourse';state.instance='fresh-page';
r=await a.call('set_scope',{subjectCode:'BIO',mode:'final'},17374,false);
assert.equal(Object.keys(storage).length,1);assert.ok(r.resumeToken);
console.log('Session recovery passed: port/worker restart, Loop ledger, pacing, confirmed submission/review, ownership, stale page, uncertain action, Normal manual/history-off, storage failure and expiry');
