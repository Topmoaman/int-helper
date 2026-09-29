import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { readIntTimer } from '../src/web-adapters/int-timer.mjs';
const node = (innerText, visible = true) => ({ innerText, getClientRects: () => visible ? [1] : [] });
let digits = ['01:', '50:', '59'];
const timer = { ...node(''), querySelector: s => node(digits[['.jst-hours','.jst-minutes','.jst-seconds'].indexOf(s)]) };
let timers = [timer];
const document = { querySelectorAll: s => s === '.timer' ? timers : [] };
assert.equal(readIntTimer(document).remainingSeconds, 6659);
digits = ['01:', ' 50: ', '00']; assert.equal(readIntTimer(document).display, '01:50:00');
for (const invalid of [['01:', '60:', '00'], ['01:', '50:', ''], ['99:', '00:', '00']]) {
  digits = invalid; assert.equal(readIntTimer(document).available, false);
}
timers = []; assert.equal(readIntTimer(document).available, false);
timers = [timer, timer]; assert.equal(readIntTimer(document).available, false);
timers = [{ ...timer, getClientRects: () => [] }]; assert.equal(readIntTimer(document).available, false);

const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url))).version;
for (const loop of [false, true]) for (const autoSubmit of [false, true]) {
  let handler, now = 1_800_000_000_000, number = 1, remaining = 7200, available = true, enteredAt;
  let origin = 'https://int-project.com';
  const applied = [], submissions = [], stored = {};
  class Clock extends Date { static now() { return now; } }
  class Socket { static OPEN = 1; readyState = 1; send() {} }
  const chrome = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    storage: { session: { get: async k => k ? { [k]: stored[k] } : structuredClone(stored), set: async o => Object.assign(stored, structuredClone(o)), remove: async k => { delete stored[k]; } } },
    tabs: { query: async () => [{ id: 1, active: true, url: origin + '/student/virtual_school/exam.php' }],
      sendMessage: async (_id, m) => {
        let result;
        if (m.action === 'page_version') result = { contentVersion: version, pageInstanceId: 'fixed', url: origin + '/student/virtual_school/exam.php' };
        else if (m.action === 'inspect_page') result = { origin, path: origin.includes('int-project') ? '/student/virtual_school/index.php' : '/StudyCourse', course: { subjectCode: 'BIO', subjectName: 'Biology', level: '6', term: '1', year: '2026' } };
        else if (m.action === 'advance_subject') { enteredAt = ++now; result = { intActivity: { kind: 'exam', examType: 'F', enteredAt } }; }
        else if (m.action === 'read_question') result = { examCode: `Q:${number}`, questionNumber: number, totalQuestions: 50, choices: [], examTimer: { available, source: 'int_project_display', remainingSeconds: remaining } };
        else if (m.action === 'apply_answer') { applied.push({ number, remaining }); result = { selected: 1, examCode: `Q:${number}`, autoAdvance: true, lastQuestion: number === 50 }; number = number === 50 ? 1 : number + 1; }
        else if (m.action === 'submit_exam') { submissions.push(remaining); result = { action: 'confirmed' }; }
        else if (m.action === 'read_exam_result') result = { mode: 'result', score: { correct: 49, total: 50 } };
        else throw Error(m.action);
        return { ok: true, result };
      } },
  };
  const boot = () => runInNewContext(worker + '\nglobalThis.expose(handleBridgeRequest);', {
    chrome, WebSocket: Socket, URL, Date: Clock, console, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    setInterval() {}, setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, expose: fn => { handler = fn; },
  });
  boot();
  const call = (action, args = {}) => handler(action, args, 17373);
  await call('set_scope', { subjectCode: 'BIO', mode: 'final', autoSubmit, retryUntilPerfect: loop });
  for (const args of [{}, { durationMinutes: 60, finishAtRemaining: '01:50:00' }, { finishAtRemaining: '00:00:59' }, { finishAtRemaining: '02:00:00' }, { finishAtRemaining: '01:99:00' }]) await assert.rejects(call('set_exam_pacing', args));
  await call('set_exam_pacing', { finishAtRemaining: '01:50:00' });
  for (let round = 0; round < 2; round++) {
    number = 1; remaining = 7200;
    await call('advance_subject');
    for (let q = 1; q <= 50; q++) {
      const due = 7200 - 600 * (q - 1) / 49;
      if (q > 1) {
        remaining = Math.floor(due) + 1;
        now += 2 * 3600_000; // A local clock jump must never release an answer early.
        const waiting = await call('answer_and_next', { examCode: `Q:${q}`, choiceIndex: 1, save: true });
        assert.equal(waiting.action, 'waiting'); assert.ok(waiting.waitMs <= 60000);
        assert.equal(applied.length, round * 50 + q - 1);
        if (q === 2 && round === 0) {
          const token = waiting.resumeToken;
          boot();
          await call('resume_scope', { resumeToken: token });
          assert.equal((await call('answer_and_next', { examCode: 'Q:2', choiceIndex: 1, save: true })).action, 'waiting');
          available = false;
          assert.equal((await call('answer_and_next', { examCode: 'Q:2', choiceIndex: 1, save: true })).action, 'timer_unavailable');
          available = true;
          remaining = 7200;
          assert.equal((await call('answer_and_next', { examCode: 'Q:2', choiceIndex: 1, save: true })).action, 'timer_increased');
        }
      }
      remaining = Math.floor(due);
      const answer = await call('answer_and_next', { examCode: `Q:${q}`, choiceIndex: 1, save: true });
      assert.equal(answer.answeredExamCode, `Q:${q}`);
    }
    assert.equal(applied.at(-1).remaining, 6600);
    const submitted = await call('submit_current_exam', { examCode: 'Q:1' });
    assert.equal(submitted.action, autoSubmit || loop ? 'confirmed' : 'manual_submission_required');
    assert.equal(submissions.length, autoSubmit || loop ? round + 1 : 0);
  }
  // Setting midway spreads only remaining questions, using the observed 59 seconds.
  number = 27; remaining = 6659;
  await call('advance_subject');
  await call('set_exam_pacing', { finishAtRemaining: '01:50:00' });
  await call('answer_and_next', { examCode: 'Q:27', choiceIndex: 1, save: true });
  remaining = 6601; number = 50;
  assert.equal((await call('answer_and_next', { examCode: 'Q:50', choiceIndex: 1, save: true })).waitMs, 1000);
  await call('set_exam_pacing', { finishAtRemaining: '01:55:00' });
  assert.equal((await call('answer_and_next', { examCode: 'Q:50', choiceIndex: 1, save: true })).action, 'timer_target_already_passed');
  await call('set_exam_pacing', { durationMinutes: 0 });
  available = false;
  assert.equal((await call('answer_and_next', { examCode: 'Q:50', choiceIndex: 1, save: true })).done, true);
  origin = 'https://main.virtualschool.club';
  await call('set_scope', { subjectCode: 'BIO', mode: 'final' });
  assert.equal((await call('set_exam_pacing', { finishAtRemaining: '01:50:00' })).timingSource, 'virtual_school_display');
}
console.log('Countdown passed: rendered timer parsing, Normal/Loop, manual/auto, 50 answers and retries, local-clock divergence, paused/missing/increased timer, checkpoint recovery, mid-attempt 59 seconds, past target, off and Virtual configuration');
