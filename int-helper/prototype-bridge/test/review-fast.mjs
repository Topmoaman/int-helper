import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHistory } from '../src/history.mjs';
const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
let navigate, now = 0, state = 'question', reads = 0, clicks = [];
const answers = new Map(Array.from({length:50}, (_,i) => [i+1, {questionNumber:i+1, examCode:'Q'+(i+1), questionText:'Q'+(i+1), selectedChoiceIndex:2, choices:[{index:1,text:'A'}, {index:2,text:'B'}]}]));
const sheet = Array.from({length:50},(_,i)=>({questionNumber:i+1,selectedChoiceIndex:2,correctness:i<40?'correct':'incorrect'}));
const session = {submitted:true,attemptAnswers:answers,scope:{retryUntilPerfect:true,intActivity:{examType:'F',finalResult:{correct:40}}}};
let stall = false;
runInNewContext(worker.slice(worker.indexOf('const selectiveReview ='),worker.indexOf('const handleRequest ='))+'\nexpose(navigateReview);', {
  URL, expose: fn=>navigate=fn, Date:{now:()=>now}, delay:async ms=>{now+=ms;},
  sendToPage:async (_id,msg)=>{
    if(msg.action==='open_answer_review'){
      if(msg.expectedResultToken!==state) throw Error('Result changed; read it again');
      clicks.push(msg.step);
      if(state==='question'){state='sheet';return {action:'opened_sheet'};}
      if(state==='sheet'){if(!stall)state='destination';return {action:'next'};}
    }
    reads++;
    const n=state==='destination'?41:1;
    return {...answers.get(n),url:'https://int-project.com/student/virtual_school/exam_answer.php',resultToken:state,totalQuestions:50,correctChoiceIndex:n===41?1:2,verificationSource:'INT explicit correct-answer label',sheet:state==='sheet'?sheet:[]};
  }
});
const result=await navigate(1,session,{resultToken:'question',step:'question',questionNumber:41});
assert.equal(result.questionNumber,41);
assert.deepEqual(clicks,['question','question']);
assert.equal(reads,2,'sheet and destination read without extra model calls');
assert.equal(result.verifiedReviews.length,40,'intermediate greens must reach history');
assert.equal(result.rejectedReviews.length,10);
assert.equal(result.reviewPlan.remainingCount,9);
await assert.rejects(navigate(1,session,{resultToken:'stale',step:'question',questionNumber:42}),/Result changed/);
state='question'; stall=true;
const timedOut=await navigate(1,session,{resultToken:'question',step:'question',questionNumber:41});
assert.equal(timedOut.navigationPending,true);
await assert.rejects(navigate(1,session,{resultToken:'sheet',step:'question',questionNumber:41},()=>{throw Error('Scope expired');}),/Scope expired/);
const folder=mkdtempSync(join(tmpdir(),'review-match-'));
try {
 const scope={origin:'https://int-project.com',subjectCode:'q1',subjectName:'ไทย',level:'6',term:'1',year:'2026'};
 const history=createHistory(folder,scope);
 const q={questionText:'cafe\u0301',choices:[{index:1,text:'A'},{index:2,text:'B'}]};
 history.rememberReview({...q,correctChoiceIndex:2,verificationSource:'INT explicit correct-answer label'});
 assert.equal(history.lookup({...q,questionText:'café',choices:[{index:1,text:'B'},{index:2,text:'A'}]}).choiceIndex,1);
 assert.equal(history.lookupDetailed({...q,choices:[{index:1,text:'C'},{index:2,text:'B'}]}).reason,'different_choices');
 assert.equal(history.lookupDetailed({...q,questionText:'other'}).reason,'no_verified_match');
 const second=createHistory(folder,scope);
 second.rejectAnswer({...q,selectedChoiceIndex:2,correctness:'incorrect',verificationSource:'INT submitted answer-sheet marker'});
 assert.equal(history.lookupDetailed(q).reason,'answer_rejected','cache notices another writer');
 second.rememberReview({...q,correctChoiceIndex:1,verificationSource:'INT explicit correct-answer label'});
 assert.equal(history.lookup(q).choiceIndex,1);
} finally {rmSync(folder,{recursive:true,force:true});}
// Popup rendering exercises live states without a browser or network.
const nodes=new Map(); let render, status={ports:[1,2],page:'ready',version:'test',pageVersion:'test',scopes:[],otherScopedTabs:1};
runInNewContext(readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8')+'\nexpose(refresh);',{
 document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}},
 chrome:{runtime:{sendMessage:async()=>status}},setInterval(){},expose:fn=>render=fn,
});
await new Promise(resolve=>setImmediate(resolve));
assert.match(nodes.get('scope').textContent,/แท็บนี้/);
assert.match(nodes.get('scope-help').textContent,/แท็บอื่น 1/);
status={...status,scopes:[{subjectName:'ภาษาไทย',mode:'final',retryUntilPerfect:true,durationMinutes:60}]};
await render(); assert.match(nodes.get('scope-help').textContent,/60 นาที/);assert.equal(nodes.get('scope').textContent,'ภาษาไทย');
status={...status,scopes:[{origin:'https://unknown.example',subjectName:'Unknown course',mode:'final',retryUntilPerfect:true}]};
await render(); assert.match(nodes.get('scope').textContent,/เว็บไซต์ไม่รองรับ/);assert.doesNotMatch(nodes.get('scope').textContent,/INT Project/);
status={error:'offline'}; await render();assert.equal(nodes.get('scope-help').textContent,'');
console.log('Fast review passed: one call joins 40 greens + jumps to red; stale token/timeout; NFC/shuffle/different options; live history cache; compact popup states');
let getStatus;
runInNewContext(worker.slice(worker.indexOf('const getStatus ='),worker.indexOf('chrome.runtime.onMessage.addListener'))+'\nexpose(getStatus);',{
 expose:fn=>getStatus=fn, connectedPorts:()=>[1,2], sessions:new Map([[1,{tabId:10,scope:{subjectCode:'Thai'}}],[2,{tabId:20,scope:{subjectCode:'Math'}}],[3,{tabId:10,scope:{subjectCode:'stale'}}]]),
 chrome:{runtime:{getManifest:()=>({version:'test'})},tabs:{query:async()=>[{id:10,url:'https://int-project.com/student/virtual_school/exam_answer.php'}],sendMessage:async()=>({ok:true,result:{contentVersion:'test'}})}},setTimeout:()=>1,clearTimeout(){}
});
const scopedStatus=await getStatus();assert.equal(scopedStatus.scopes.length,1);assert.equal(scopedStatus.scopes[0].subjectCode,'Thai');assert.equal(scopedStatus.otherScopedTabs,1);
console.log('Status passed: current tab, other tab, disconnected stale scope filtering');
