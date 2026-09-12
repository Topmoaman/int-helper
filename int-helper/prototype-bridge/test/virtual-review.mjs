import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../extension/content-script.js', import.meta.url), 'utf8');
const evidence = new URL('fixtures/virtual-school/', import.meta.url);
const origin = 'https://main.virtualschool.club';
const query = '?code=22&subject=22&subjectCode=22&subj=22&level=J&term=2&year=2569&examtype=F';
const scope = { origin, subjectCode:'22', level:'J', term:'2', year:'2569', mode:'final' };
// Reduced DOM harness reads the actual discovery fragments rather than embedding invented site selectors.
const parse = html => {
  const node = (tag='', attrs={}) => ({tag, attrs, children:[], parts:[], parentElement:null, clicks:0,
    get id(){return this.attrs.id || '';}, get disabled(){return 'disabled' in this.attrs;},
    get hidden(){return 'hidden' in this.attrs;}, get style(){return {display:/display:\s*none/u.test(this.attrs.style || '')?'none':''};},
    get value(){return this.attrs.value || '';}, get checked(){return 'checked' in this.attrs;},
    get src(){return this.attrs.src ? new URL(this.attrs.src,origin).href : '';}, get currentSrc(){return this.src;},
    get firstElementChild(){return this.children[0] || null;},
    get nextElementSibling(){const a=this.parentElement?.children || [];return a[a.indexOf(this)+1] || null;},
    get innerText(){return this.parts.map(p=>typeof p==='string'?p:p.innerText).join(' ');},
    getAttribute(name){return this.attrs[name] ?? null;}, getClientRects(){return this.hidden || this.style.display==='none'?[]:[1];},
    querySelectorAll(selector){return descendants(this).filter(n=>selector.split(',').some(s=>matches(n,s.trim())));},
    querySelector(selector){return this.querySelectorAll(selector)[0] || null;}, click(){this.clicks++;},
  });
  const descendants = root => root.children.flatMap(child=>[child,...descendants(child)]);
  const simpleMatches=(n,s)=>{
    const match=s.match(/^([a-z][a-z0-9-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(\^=|\*=|=)"([^"]*)"\])?$/u);
    if(!match)throw Error('Unsupported fixture selector '+s);
    const [,tag,id,cls,attr,op,value]=match;
    const a=n.attrs[attr] || '';
    return (!tag || n.tag===tag) && (!id || n.id===id) && (!cls || (n.attrs.class || '').split(/\s/u).includes(cls)) &&
      (!attr || (op==='^='?a.startsWith(value):op==='*='?a.includes(value):a===value));
  };
  const matches=(n,s)=>{
    const parts=s.split(/\s+/u).filter(Boolean);
    let current=n;
    if(!simpleMatches(current,parts.at(-1)))return false;
    for(let i=parts.length-2;i>=0;i--){
      current=current.parentElement;
      while(current && !simpleMatches(current,parts[i]))current=current.parentElement;
      if(!current)return false;
    }
    return true;
  };
  const root=node('body'), stack=[root];
  for(const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/gu) || []){
    if(token.startsWith('<!--'))continue;
    if(token.startsWith('</')){const tag=token.slice(2,-1).trim();while(stack.length>1){if(stack.pop().tag===tag)break;}continue;}
    if(token.startsWith('<')){
      const tag=token.match(/^<([a-z0-9-]+)/iu)?.[1];if(!tag)continue;
      const attrs={};for(const m of token.slice(tag.length+1,-1).matchAll(/([\w-]+)(?:="([^"]*)")?/gu))attrs[m[1]]=m[2]??'';
      const child=node(tag,attrs), parent=stack.at(-1);child.parentElement=parent;parent.children.push(child);parent.parts.push(child);
      if(!['img','br','input','hr','meta','link'].includes(tag))stack.push(child);
    }else stack.at(-1).parts.push(token.replaceAll('&nbsp;',' ').replaceAll('&amp;','&'));
  }
  return root;
};
const start=(html,path='/examanswers',search=query)=>{
  const body=parse(html);let listener;
  const document={body,querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),getElementById:id=>body.querySelector('#'+id)};
  runInNewContext(source,{URL,document,globalThis:{},setInterval(){},location:{hostname:new URL(origin).hostname,pathname:path,href:origin+path+search},
    chrome:{runtime:{sendMessage:async()=>{},onMessage:{addListener:fn=>listener=fn}}}});
  return {body,call:message=>{let response;listener(message,null,r=>response=r);return response;}};
};
const read=fixture=>{const r=fixture.call({action:'read_exam_result',scope});assert.equal(r.ok,true,r.error);return r.result;};
const single=readFileSync(new URL('review-single-fragment.html',evidence),'utf8');
const all=readFileSync(new URL('review-all-fragment.html',evidence),'utf8');
const submitted=readFileSync(new URL('submitted-result-fragment.html',evidence),'utf8');
const submittedPage=start(submitted,'/Exam');
const submittedResult=read(submittedPage);
assert.equal(submittedResult.score?.correct,45,'live success-modal score must be structured');
assert.equal(submittedResult.score?.total,50);
assert.equal(submittedResult.score?.passed,true);
assert.equal(submittedResult.reviewAvailable,true);
assert.equal(read(submittedPage).resultToken,submittedResult.resultToken,'reading an unchanged result must keep its token');
// The live exam clock keeps ticking behind the submitted-result dialog.
const submittedClock=submittedPage.body.querySelectorAll('div').find(n=>n.innerText.includes('เวลาสอบ'));
submittedClock.parts=['เวลาสอบ 01:50:31'];
const afterClockTick=submittedPage.call({action:'open_answer_review',expectedResultToken:submittedResult.resultToken,step:'open',scope});
assert.equal(afterClockTick.ok,true,`a clock tick must not invalidate the submitted result: ${afterClockTick.error}`);
for(const clock of ['01:49:59','00:59:59','00:00:00']){
 submittedClock.parts=[`เวลาสอบ ${clock}`];
 assert.equal(read(submittedPage).resultToken,submittedResult.resultToken,'clock-only changes preserve the exact submitted result');
}
for(const [name,mutate] of [
 ['score',page=>{page.body.querySelectorAll('strong')[0].parts=['44'];}],
 ['attempt identity',page=>{page.body.parts.push('รหัสข้อสอบ: DIFFERENT');}],
 ['result text',page=>{page.body.parts.push('ผลการสอบเปลี่ยนแปลง');}],
 ['review control',page=>{page.body.querySelector('button').parts=['ไม่มีเฉลย'];}],
]){
 const page=start(submitted,'/Exam'),token=read(page).resultToken;
 mutate(page);
 const response=page.call({action:'open_answer_review',expectedResultToken:token,step:'open',scope});
 assert.equal(response.ok,false,`${name} changes must still invalidate a submitted-result token`);
 assert.equal(page.body.querySelector('button').clicks,0,'a changed result must never navigate');
}

assert.equal(submittedPage.call({action:'open_answer_review',expectedResultToken:submittedResult.resultToken,step:'open',scope}).result.action,'opened_review');
assert.equal(read(start(submitted.replace('45</strong>','0</strong>').replace('ผ่านเกณฑ์! เยี่ยมยอดมาก','ไม่ผ่านเกณฑ์'),'/Exam')).score.passed,false);
assert.equal(read(start(submitted.replace('45</strong>','51</strong>'),'/Exam')).score,null,'invalid score is never accepted');
assert.equal(read(start(submitted.replace('<strong>45</strong>',''),'/Exam')).score,null,'percentage and exam total cannot replace a missing score');
assert.equal(start(submitted.replace('ดูเฉลยคำตอบ</button>','ดูเฉลยคำตอบ</button><span>ได้คะแนน 44 คะแนนเต็ม 50</span>'),'/Exam').call({action:'read_exam_result',scope}).ok,false,'conflicting submitted score labels are ambiguous');
// Live answered reviews use a combined selected/correct badge on green choices.
const liveGreen=all.replace('ผิด (ไม่ได้เลือกคำตอบ)','ถูก').replace('เฉลยที่ถูกต้อง','ตอบข้อนี้ และตอบถูก');
const greenResult=read(start(liveGreen,'/AllExamAnswers')).verifiedReviews[0];
assert.equal(greenResult.correctChoiceIndex,3);
assert.equal(greenResult.selectedChoiceIndex,3);
assert.equal(greenResult.correctness,'correct');
assert.equal(greenResult.choices[2].checked,true);
const liveRed=all.replace('ผิด (ไม่ได้เลือกคำตอบ)','ผิด').replace('<img src="/answers_pic/fixture-answer-1.jpg"></div>','<img src="/answers_pic/fixture-answer-1.jpg"></div><p><span>เป็นคำตอบที่เลือก</span></p>');
const redResult=read(start(liveRed,'/AllExamAnswers')).verifiedReviews[0];
assert.equal(redResult.correctChoiceIndex,3);
assert.equal(redResult.selectedChoiceIndex,1);
assert.equal(redResult.correctness,'incorrect');
assert.equal(redResult.selectionState,'selected');
assert.equal(redResult.choices[0].checked,true);
assert.equal(start(liveGreen.replace('ตอบข้อนี้ และตอบถูก','ตอบข้อนี้ และตอบถูก</span><span>เฉลยที่ถูกต้อง'),'/AllExamAnswers').call({action:'read_exam_result',scope}).ok,false,'duplicate correct labels remain ambiguous');
assert.equal(start(liveRed.replace('<img src="/answers_pic/fixture-answer-2.jpg"></div>','<img src="/answers_pic/fixture-answer-2.jpg"></div><span>เป็นคำตอบที่เลือก</span>'),'/AllExamAnswers').call({action:'read_exam_result',scope}).ok,false,'two selected choices must be rejected');
assert.equal(start(liveRed.replace('<span>ผิด</span>','<span>ผิด (ไม่ได้เลือกคำตอบ)</span>'),'/AllExamAnswers').call({action:'read_exam_result',scope}).ok,false,'selected and unanswered evidence must not coexist');
const answeredCard=html=>html.match(/<section[\s\S]*<\/section>/u)[0];
const wrongNumbers=new Set([3,22,28,45,49]);
const answeredSet='<div><span>คะแนนรวม</span><span>45/50</span></div>'+Array.from({length:50},(_,i)=>{
 const n=i+1;
 return answeredCard(wrongNumbers.has(n)?liveRed:liveGreen).replace('question-3',`question-${n}`).replace('ข้อ 3',`ข้อ ${n}`);
}).join('');
const answeredSetResult=read(start(answeredSet,'/AllExamAnswers'));
assert.equal(answeredSetResult.reviewComplete,true);
assert.equal(answeredSetResult.ready,true);
assert.equal(answeredSetResult.verifiedReviews.length,50);
assert.equal(answeredSetResult.verifiedReviews.filter(r=>r.correctness==='correct').length,45);
assert.equal(answeredSetResult.verifiedReviews.filter(r=>r.correctness==='incorrect').map(r=>r.questionNumber).join(','),'3,22,28,45,49');
// Full card count is insufficient while image identity can still change.
const loadingSet=start(answeredSet.replace(/(<section[^>]*id="question-20"[^>]*>)/u, '$1<img src="/question_pic/pending-placeholder.jpg">'),'/AllExamAnswers');
const pendingImage=loadingSet.body.querySelectorAll('img[src*="/question_pic/"]')[0];
pendingImage.complete=false;
let loadingReview=read(loadingSet);
assert.equal(loadingReview.ready,false,'do not bind a complete card set before its images settle');
assert.equal(loadingReview.reviewComplete,false);
assert.equal(loadingReview.pendingImageCount,1);
pendingImage.complete=true;pendingImage.naturalWidth=0;
loadingReview=read(loadingSet);
assert.equal(loadingReview.reviewComplete,false,'failed visible images need resolution before binding');
pendingImage.attrs.style='display: none;';
const settledReview=read(loadingSet);
assert.equal(settledReview.reviewComplete,true,'the site removed its unavailable image after loading');
assert.equal(settledReview.verifiedReviews[19].questionImage,null);
assert.equal(settledReview.pendingImageCount,0);
assert.equal(settledReview.failedImageCount,0);
const activeImageChoices=`<main><h2>ข้อคำถามที่ 1</h2><div class="exam-question">โจทย์ภาพ</div><div>รหัสข้อสอบ: EXAM</div><div>ทั้งหมด 2 ข้อ</div><input type="radio" value="synthetic-radio-caption"><label><img src="/answers_pic/fixture-answer-1.jpg"></label><input type="radio" value="ข้อความสำรอง"><label>ข้อความตัวเลือก</label></main>`;
let fixture=start(activeImageChoices,'/Exam'), active=fixture.call({action:'read_question'});
assert.equal(active.ok,true,active.error);assert.equal(active.result.choices[0].text,'');
assert.equal(active.result.choices[0].image,origin+'/answers_pic/fixture-answer-1.jpg');assert.equal(active.result.choices[1].text,'ข้อความตัวเลือก');
fixture=start(activeImageChoices.replace('<div class="exam-question">โจทย์ภาพ</div>','<div class="exam-question">โจทย์ภาพ</div><img src="/question_pic/hidden.jpg" style="display: none;">'),'/Exam');
active=fixture.call({action:'read_question'});
assert.equal(active.ok,true,active.error);assert.equal(active.result.questionImage,null,'hidden active question images are ignored consistently with review');
fixture=start(single);let result=read(fixture);
assert.equal(result.questionNumber,1);assert.equal(result.totalQuestions,50);assert.equal(result.score.correct,0);assert.equal(result.ready,true);
assert.equal(result.examCode,null);assert.equal(result.correctChoiceIndex,3);assert.equal(result.selectedChoiceIndex,null);
assert.equal(result.selectionState,'unanswered');assert.equal(result.correctness,'incorrect');
assert.equal(result.questionText,'โจทย์ตัวอย่างสำหรับทดสอบเฉลยรายข้อ');
assert.equal(result.choices[2].text,'ตัวเลือกตัวอย่างสาม');assert.equal(result.questionImage,origin+'/question_pic/fixture-question-1.jpg');
assert.equal(result.verificationSource,'Virtual School explicit correct-answer label');
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:'stale',step:'sheet',scope}).ok,false);
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'sheet',scope}).result.action,'opened_all_review');
assert.equal(fixture.body.querySelectorAll('button').find(b=>b.innerText.trim()==='ดูเฉลยทุกข้อในชุดนี้').clicks,1);
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'next',scope}).result.action,'next');
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'question',questionNumber:2,scope}).result.action,'next');
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'question',questionNumber:51,scope}).ok,false);
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'return',scope}).result.action,'returned');
fixture=start(single.replace('คุณไม่ได้เลือกคำตอบในข้อนี้',''));result=read(fixture);
assert.equal(result.selectionState,'unknown');assert.equal(result.correctness,'unverified');assert.equal(result.choices[2].checked,null);
fixture=start(single.replace('คำตอบที่ถูกต้อง</span>','ไม่ได้ยืนยัน</span>'));
assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,'color and secondary summary alone do not replace the observed single-view badge');
fixture=start(single.replace(' / 50',' / 0'));result=read(fixture);
assert.equal(result.ready,false);assert.equal(result.score,null);assert.equal(result.verifiedReviews.length,0);
fixture=start(all,'/AllExamAnswers');result=read(fixture);
assert.equal(result.reviewLayout,'all');assert.equal(result.ready,false,'reduced fragment contains only one of the 50 actual cards');
assert.equal(result.verifiedReviews.length,1);assert.equal(result.verifiedReviews[0].correctChoiceIndex,3);
assert.equal(result.verifiedReviews[0].questionNumber,3);assert.equal(result.verifiedReviews[0].choices[0].image,origin+'/answers_pic/fixture-answer-1.jpg');
assert.equal(result.verifiedReviews[0].choices[0].text,'');
const card=all.match(/<section[\s\S]*<\/section>/u)[0];
const complete=all.slice(0,all.indexOf('<section'))+Array.from({length:50},(_,i)=>card.replace('question-3','question-'+(i+1)).replace('ข้อ 3','ข้อ '+(i+1))).join('\n');
fixture=start(complete,'/AllExamAnswers');result=read(fixture);
assert.equal(result.ready,true);assert.equal(result.reviewComplete,true);assert.equal(result.verifiedReviews.length,50);
fixture=start(complete.replace('0/50','50/50'),'/AllExamAnswers');result=read(fixture);
assert.equal(result.score.correct,50);assert.equal(result.score.total,50);assert.equal(result.ready,true);assert.equal(result.reviewComplete,true);
const three=all.slice(0,all.indexOf('<section'))+Array.from({length:3},(_,i)=>card.replace('question-3','question-'+(i+1)).replace('ข้อ 3','ข้อ '+(i+1))).join('\n');
fixture=start(three.replace('0/50','2/3'),'/AllExamAnswers');result=read(fixture);
assert.equal(result.score.correct,2);assert.equal(result.score.total,3);assert.equal(result.ready,true);assert.equal(result.reviewComplete,true);assert.equal(result.verifiedReviews.length,3);
fixture=start(complete.replace('id="question-2"','id="question-1"'),'/AllExamAnswers');
assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,'duplicate all-review question numbers are invalid');
fixture=start(complete,'/AllExamAnswers');result=read(fixture);
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'sheet',scope}).result.action,'all_review_already_open');
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'return',scope}).result.action,'returned');
fixture=start(single.replace('src="/question_pic/fixture-question-1.jpg"','src="/question_pic/fixture-question-1.jpg" style="display: none;"'));result=read(fixture);
assert.equal(result.questionImage,null);assert.equal(result.unavailableImageCount,1);assert.equal(result.questionText,'โจทย์ตัวอย่างสำหรับทดสอบเฉลยรายข้อ');
fixture=start(single);const failedImage=fixture.body.querySelectorAll('img[src*="/question_pic/"]')[0];failedImage.complete=true;failedImage.naturalWidth=0;result=read(fixture);
assert.equal(result.questionImage,origin+'/question_pic/fixture-question-1.jpg');assert.equal(result.unavailableImageCount,0);assert.equal(result.failedImageCount,1,'visible failed images remain URL identity with a warning count');
fixture=start(all.replace('src="/answers_pic/fixture-answer-1.jpg"','src="/answers_pic/fixture-answer-1.jpg" style="display: none;"'),'/AllExamAnswers');
assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,'missing image-only choice cannot become a partial identity');
fixture=start(single);result=read(fixture);fixture.body.parts.push('changed after result read');
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'return',scope}).ok,false,'review token must expire when the DOM changes');
fixture=start(single);result=read(fixture);
const imageOnlyTokenText=fixture.body.innerText;
fixture.body.querySelectorAll('img[src*="/question_pic/"]')[0].attrs.src='/question_pic/changed.jpg';
assert.equal(fixture.body.innerText,imageOnlyTokenText,'image-only token test must keep visible text constant');
assert.equal(fixture.call({action:'open_answer_review',expectedResultToken:result.resultToken,step:'return',scope}).ok,false,'review token must expire when only an image URL changes');
fixture=start(single.replace('คำตอบที่ถูกต้อง</span>','คำตอบที่ถูกต้อง</span><span>คำตอบที่ถูกต้อง</span>'));
assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,'duplicate explicit correct labels are ambiguous');
fixture=start(single.replace('<div>ค</div>','<div>ข</div>'));
assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,'choice glyph order is required');
fixture=start(single+'<p>คะแนนรวม</p><div>1/50</div>');
assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,'conflicting score summaries are ambiguous');
for(const path of ['/examanswers','/AllExamAnswers']){
 fixture=start(path==='/examanswers'?single:all,path,query.replace('year=2569','year=2570'));
 assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false);
 fixture=start(path==='/examanswers'?single:all,path,query.replace('subject=22','subject=23'));
 assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false);
 fixture=start(path==='/examanswers'?single:all,path,query.replace('examtype=F','examtype=A'));
 assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false);
}
for(const alias of ['subject','subjectCode','subj','code']){
 fixture=start(single,'/examanswers',query.replace(`${alias}=22`,`${alias}=23`));
 assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,`conflicting ${alias} aliases must be rejected`);
}
for(const [key,value] of [['level','K'],['term','3'],['year','2570']]){
 fixture=start(single,'/examanswers',query.replace(`${key}=${key==='level'?'J':key==='term'?'2':'2569'}`,`${key}=${value}`));
 assert.equal(fixture.call({action:'read_exam_result',scope}).ok,false,`conflicting ${key} identity must be rejected`);
}
console.log('Virtual review passed: observed single/all DOM, explicit labels, unknown/absent selection, score/loading, complete set, images, tokens/navigation and exact course scope');
