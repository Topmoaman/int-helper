import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHistory } from '../src/history.mjs';
import { answerKnownQuestions } from '../src/known-answers.mjs';
const directory=mkdtempSync(join(tmpdir(),'int-bank-'));
try {
 const scope={origin:'https://int-project.com',subjectCode:'q1',subjectName:'Thai',level:'6',term:'1',year:'2026'};
 const a=createHistory(directory,scope), b=createHistory(directory,scope);
 const q={questionText:'Q',choices:[{index:1,text:'A'},{index:2,text:'B'}]};
 const review={...q,correctChoiceIndex:2,verificationSource:'INT explicit correct-answer label',evidence:'B'};
 a.rememberReview(review);
 b.rememberReview({...review,choices:[{index:1,text:'B'},{index:2,text:'A'}],correctChoiceIndex:1});
 assert.equal(a.stats().verifiedRecords,1,'repeated/shuffled verified answers are not appended again');
 const original=readFileSync(a.file,'utf8').trim().split('\n').map(JSON.parse).find(r=>r.type==='verified_answer');
 a.append(original); // a duplicate from an older journal
 const stats=a.stats();
 assert.equal(stats.duplicateVerifiedRecords,1);assert.equal(stats.uniqueVerifiedQuestions,1);assert.equal(stats.usableAnswers,1);
 assert.equal(JSON.parse(readFileSync(a.bankFile,'utf8')).entries.length,1,'canonical bank has one question');
 b.rejectAnswer({...q,selectedChoiceIndex:2,correctness:'incorrect',verificationSource:'INT submitted answer-sheet marker'});
 assert.equal(a.lookup(q),null,'another writer rejection invalidates the indexed match');
 b.rememberReview({...review,correctChoiceIndex:1});assert.equal(a.lookup(q).choiceIndex,1);
 b.rememberReview(review);assert.equal(a.stats().conflicts,1);assert.equal(a.lookup(q),null);
 assert.equal(JSON.parse(readFileSync(a.bankFile,'utf8')).entries.length,1,'conflicting answers stay on the same question, not duplicate question rows');
} finally {rmSync(directory,{recursive:true,force:true});}
const known=n=>({examCode:'Q'+n,questionNumber:n,choices:[{index:1,text:'A'}],verifiedAnswer:{correctness:'verified',choiceIndex:1}});
let calls=[];
const batch=await answerKnownQuestions({read:async()=>known(1),answer:async payload=>{calls.push(payload);return {...(calls.length===3?{examCode:'Q4',choices:[{index:1,text:'B'}]}:known(calls.length+1)),selected:1};}});
assert.equal(batch.knownAnswersApplied,3);assert.equal(batch.batchStopReason,'needs_reasoning');assert.deepEqual(calls.map(c=>c.examCode),['Q1','Q2','Q3']);
const pace=await answerKnownQuestions({read:async()=>known(1),answer:async()=>({mode:'pacing',answerApplied:false,waitMs:10})});assert.equal(pace.knownAnswersApplied,0);
const sync=await answerKnownQuestions({read:async()=>known(1),answer:async()=>({mode:'resync',answerApplied:false})});assert.equal(sync.knownAnswersApplied,0);
for(const reused of [false,true]) {
 let navigations=0;
 const waiting=await answerKnownQuestions({read:async()=>known(35),answer:async()=>{
  navigations++;return {...known(35),selected:1,done:false,navigationPending:true,selectionReused:reused};
 }});
 assert.equal(navigations,1);assert.equal(waiting.batchStopReason,'navigation_pending');
 assert.equal(waiting.knownAnswersApplied,reused?0:1);
}
const end=await answerKnownQuestions({read:async()=>known(50),answer:async()=>({done:true,examCode:'Q1',selected:1})});assert.equal(end.knownAnswersApplied,1);assert.equal(end.batchStopReason,'exam_answered');
let count=0;const capped=await answerKnownQuestions({maxQuestions:2,read:async()=>known(1),answer:async()=>({...known(++count+1),selected:1})});assert.equal(capped.knownAnswersApplied,2);
await assert.rejects(answerKnownQuestions({read:async()=>known(1),answer:async()=>{throw Error('should not run');},stillAuthorized:()=>false}),/scope changed/);
console.log('Bank and batch passed: legacy dedup, no new duplicates, cross-writer correction/conflict, only exact known answers, unknown/pacing/resync/done/scope/limit stops');

let imageAnswers=0;
const unreadable=await answerKnownQuestions({read:async()=>({...known(16),imagesPending:true}),answer:async()=>{imageAnswers++;}});
assert.equal(unreadable.batchStopReason,'images_pending');assert.equal(imageAnswers,0);
const nextUnreadable=await answerKnownQuestions({read:async()=>known(15),answer:async()=>({...known(16),selected:1,imagesPending:true})});
assert.equal(nextUnreadable.knownAnswersApplied,1);assert.equal(nextUnreadable.batchStopReason,'images_pending');
