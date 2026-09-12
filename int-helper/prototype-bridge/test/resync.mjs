import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source=readFileSync(process.argv[2] || new URL('../extension/service-worker.js',import.meta.url),'utf8');
const session={scope:{retryUntilPerfect:true,intActivity:{}},attemptAnswers:new Map([[1,{examCode:'FIRST'}],[50,{examCode:'LAST'}]])};
let current={examCode:'FIRST',questionNumber:1,totalQuestions:50,choices:[]}, calls=[],fail='',answer,submit;
runInNewContext(source.slice(source.indexOf('const pacingWait ='),source.indexOf('const advanceSubject ='))+source.slice(source.indexOf('const submitCurrentExam ='),source.indexOf('// Only join sheet'))+'\nexpose(answerAndNext,submitCurrentExam);',{
 expose:(a,s)=>{answer=a;submit=s;},configuredSession:()=>session,hydrateImages:async q=>q,hydrateQuestion:async q=>q,
 sendScoped:async (_session,msg)=>{calls.push(msg);if(msg.action==='read_question')return current;if(fail)throw Error(fail);return {action:'confirmed',selected:1};},
 navigateNext:async()=>({done:true}),Date,
});
const stale=await answer({examCode:'LAST',choiceIndex:5,save:true},1);
assert.equal(stale.mode,'resync');assert.equal(stale.examCode,'FIRST');assert.equal(stale.answerApplied,false);assert.ok(!calls.some(m=>m.action==='apply_answer'));
calls=[];
const wrapped=await submit({examCode:'LAST'},1);
assert.equal(wrapped.action,'confirmed');assert.equal(wrapped.examCode,'FIRST');assert.equal(wrapped.codeRefreshed,true);assert.equal(calls.find(m=>m.action==='submit_exam').expectedExamCode,'FIRST');
calls=[];const unknown=await submit({examCode:'FOREIGN'},1);assert.equal(unknown.mode,'resync');assert.ok(!calls.some(m=>m.action==='submit_exam'));
calls=[];fail='stale exam code: CHANGED';current={...current,examCode:'FIRST'};
assert.equal((await answer({examCode:'FIRST',choiceIndex:1,save:true},1)).mode,'resync');
assert.equal(calls.filter(m=>m.action==='apply_answer').length,1,'no blind automatic answer retry');
assert.equal((await submit({examCode:'FIRST'},1)).mode,'resync');
fail='Not every saved answer is present';await assert.rejects(submit({examCode:'FIRST'},1),/Not every saved/);
fail='Scope expired';await assert.rejects(answer({examCode:'FIRST',choiceIndex:1},1),/Scope expired/);
console.log('Resync passed: stale answer applies nothing; same-attempt 50→1 submission refresh; unknown code returns current state; race resync; saved-answer and scope refusals preserved');
