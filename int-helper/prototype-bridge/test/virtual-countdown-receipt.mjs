import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const origin = 'https://main.virtualschool.club';
for (const total of [3, 50]) for (const loop of [false, true]) for (const autoSubmit of [false, true]) {
  const storage = {}, effects = [], messages = [];
  let number = 1, remaining = 7211, now = 1000, available = true, submitted = false, failStatus = false, scopeError = false;
  let path = '/StudyCourse';
  const question = () => ({ examCode: `Q:${number}`, questionNumber: number, totalQuestions: total, questionText: `Q${number}`,
    done: false, choices: [{ index: 1, text: 'A' }], examTimer: { available, remainingSeconds: remaining, source: 'virtual_school_display' } });
  const boot = () => {
    let api;
    class Socket { static OPEN = 1; readyState = 1; send() {} }
    const identity = () => ({ contentVersion: 'test', pageInstanceId: 'same', url: origin + path,
      capabilities: ['scoped_envelope', 'page_identity', 'wait_question'] });
    const chrome = {
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
      runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener() {} } },
      storage: { session: { get: async k => structuredClone(k ? { [k]: storage[k] } : storage), set: async x => Object.assign(storage, structuredClone(x)), remove: async k => { delete storage[k]; } } },
      tabs: { query: async () => [{ id: 7, active: true, url: origin + path }], sendMessage: async (_id, raw) => {
        messages.push(raw.action);
        const m = raw.action === 'scoped_action' ? raw.request : raw;
        if (raw.action === 'scoped_action') assert.equal(raw.expectedContentVersion, 'test');
        let result;
        if (m.action === 'page_version') result = identity();
        else if (m.action === 'page_identity') result = { ...identity(), examCode: path === '/Exam' ? `Q:${number}` : null };
        else if (m.action === 'inspect_page') result = { origin, path, course: { subjectCode: 'BIO', subjectName: 'Biology', level: '6', year: '2026', term: '1' } };
        else if (m.action === 'advance_subject') { number = 1; submitted = false; path = '/Exam'; result = { virtualFinalOpened: true, virtualAttemptId: randomUUID(), virtualAttemptEnteredAt: ++now }; }
        else if (m.action === 'read_question' || m.action === 'wait_question') {
          if (scopeError) return { ok: false, error: 'Scope expired' };
          if (path !== '/Exam') return { ok: false, error: 'question metadata not found' };
          result = question();
        } else if (m.action === 'apply_answer') { effects.push('answer'); result = { examCode: `Q:${number}`, selected: 1 }; }
        else if (m.action === 'navigate_next') { result = { done: number === total }; if (number < total) number++; }
        else if (m.action === 'read_submission_status') {
          if (failStatus) return { ok: false, error: 'temporary result read failure' };
          result = { submitted, marker: submitted ? 'owned-result' : null };
        } else if (m.action === 'submit_exam') { effects.push('submit'); result = { action: 'confirmed' }; }
        else if (m.action === 'read_exam_result') result = { submittedMarker: 'owned-result', score: { correct: total - 1, total }, resultToken: 'R', url: origin + '/Exam' };
        else if (m.action === 'open_answer_review') { effects.push('review'); result = { action: 'opened_review' }; }
        else throw Error(m.action);
        return { ok: true, result };
      } },
    };
    runInNewContext(source + '\nexpose({handleBridgeRequest,sessions});', { chrome, URL, WebSocket: Socket, crypto: { randomUUID }, console,
      Date: class extends Date { static now() { return now; } }, setInterval() {}, setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, expose: x => { api = x; } });
    return { ...api, call: (action, args = {}) => api.handleBridgeRequest(action, args, 17373, loop) };
  };
  let a = boot();
  const scope = await a.call('set_scope', { subjectCode: 'BIO', mode: 'final', autoSubmit, retryUntilPerfect: loop });
  await a.call('set_exam_pacing', { finishAtRemaining: '01:50:00' });
  for (let round = 0; round < 2; round++) {
    remaining = 7211; await a.call('advance_subject');
    assert.equal(a.sessions.get(17373).scope.countdownAnchor, null);
    for (let q = 1; q <= total; q++) {
      const due = 7211 - 611 * (q - 1) / (total - 1);
      if (q > 1) {
        remaining = Math.floor(due) + 1; now += 7200000;
        const waiting = await a.call('answer_and_next', { examCode: `Q:${q}`, choiceIndex: 1, save: false });
        assert.equal(waiting.action, 'waiting'); assert.equal(waiting.timingSource, 'virtual_school_display');
        assert.equal(effects.filter(x => x === 'answer').length, round * total + q - 1);
        if (q === 2 && round === 0) {
          a = boot(); await a.call('resume_scope', { resumeToken: scope.resumeToken });
          available = false; assert.equal((await a.call('answer_and_next', { examCode: 'Q:2', choiceIndex: 1 })).action, 'timer_unavailable');
          available = true; remaining = 7212; assert.equal((await a.call('answer_and_next', { examCode: 'Q:2', choiceIndex: 1 })).action, 'timer_increased');
        }
      }
      remaining = Math.floor(due);
      const answer = await a.call('answer_and_next', { examCode: `Q:${q}`, choiceIndex: 1, save: false });
      assert.equal(answer.selected, 1); assert.equal(answer.done, q === total);
    }
    const result = await a.call('submit_current_exam', { examCode: `Q:${total}` });
    if (!(autoSubmit || loop)) { assert.equal(result.action, 'manual_submission_required'); continue; }
    assert.equal(result.action, 'confirmed');
    failStatus = true;
    await assert.rejects(a.call('submit_current_exam', { examCode: `Q:${total}` }), /temporary/);
    assert.equal(a.sessions.get(17373).recoveryPending, null, 'read-only receipt failure cannot poison recovery');
    failStatus = false;
    assert.equal((await a.call('submit_current_exam', { examCode: `Q:${total}` })).action, 'confirmation_pending');
    submitted = true; path = '/ExamAnswers';
    assert.equal((await a.call('submit_current_exam', { examCode: `Q:${total}` })).action, 'already_submitted');
    a = boot(); await a.call('resume_scope', { resumeToken: scope.resumeToken });
    const repeated = await a.call('submit_current_exam', { examCode: `Q:${total}` });
    assert.equal(repeated.submissionApplied, false); assert.equal(repeated.nextAction, 'read_exam_result');
    assert.equal(effects.filter(x => x === 'submit').length, round + 1);
    await a.call('open_answer_review', { resultToken: 'R', step: 'open', readAfter: false });
    a.sessions.get(17373).recoveryPending = 'answer_and_next';
    await assert.rejects(a.call('submit_current_exam', { examCode: `Q:${total}` }), /uncertain outcome/);
    a.sessions.get(17373).recoveryPending = null;
  }
  assert.ok(messages.includes('scoped_action')); assert.ok(messages.includes('page_identity'));
}
console.log('Virtual countdown/receipts passed: Normal/manual/auto/Loop, 3/50 questions, >2h observed anchor, two attempts, missing/increased timer, local-clock jumps, restart, delayed result and failed receipt read, no duplicate submit, genuine uncertainty retained');
