import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
for (const loop of [false, true]) {
  const origin = 'https://int-project.com', storage = {}, effects = [];
  let now = 1000000, path = '/student/virtual_school/index.php', number = 1, step = 0, throwSubmit = false;
  const question = () => ({ examCode: `Q:${number}`, questionNumber: number, totalQuestions: 50, choices: [], questionText: `Question ${number}` });
  const boot = () => {
    let api;
    class Socket { static OPEN = 1; readyState = 1; send() {} }
    const chrome = {
      storage: { session: { get: async key => structuredClone(key === null ? storage : { [key]: storage[key] }), set: async x => Object.assign(storage, structuredClone(x)), remove: async key => { delete storage[key]; } } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
      runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener() {} } },
      tabs: { query: async () => [{ id: 7, active: true, url: origin + path }], sendMessage: async (_id, m) => {
        let result;
        if (m.action === 'page_version') result = { contentVersion: 'test', pageInstanceId: 'same-page', url: origin + path };
        else if (m.action === 'inspect_page') result = { origin, path, course: { subjectCode: 'BIO', subjectName: 'Biology', year: '2026', term: '1', level: '6' } };
        else if (m.action === 'advance_subject') { path = '/student/virtual_school/exam.php'; number = 1; step = 0; result = { intActivity: { kind: 'exam', examType: 'F', enteredAt: ++now } }; }
        else if (m.action === 'read_question') {
          if (path !== '/student/virtual_school/exam.php') return { ok: false, error: 'main_quizs not found' };
          result = question();
        } else if (m.action === 'apply_answer') {
          result = { examCode: `Q:${number}`, selected: 1, autoAdvance: true, lastQuestion: number === 50 }; number = number === 50 ? 1 : number + 1;
        } else if (m.action === 'submit_exam') {
          effects.push('submit');
          if (throwSubmit) return { ok: false, error: 'connection lost during submit' };
          result = { action: ['opened_sheet','verified_sheet','opened','confirmed'][step++] };
          if (result.action === 'confirmed') path = '/student/virtual_school/exam_result.php';
        } else if (m.action === 'read_exam_result') result = { score: { correct: 41, total: 50 }, resultToken: 'result-token', choices: [] };
        else if (m.action === 'open_answer_review') { effects.push('review'); result = { action: 'opened_review' }; }
        else throw Error(m.action);
        return { ok: true, result };
      } },
    };
    runInNewContext(source + '\nexpose({handleBridgeRequest,sessions});', { chrome, URL, WebSocket: Socket, crypto: { randomUUID }, Date: class extends Date { static now() { return now; } }, console,
      setInterval() {}, setTimeout: f => { queueMicrotask(f); return 1; }, clearTimeout() {}, expose: x => { api = x; } });
    return { ...api, call: (action, payload = {}) => api.handleBridgeRequest(action, payload, 17373, loop) };
  };
  let a = boot();
  const scope = await a.call('set_scope', { subjectCode: 'BIO', mode: 'final', autoSubmit: !loop, retryUntilPerfect: loop });
  await a.call('advance_subject');
  for (let q = 1; q <= 50; q++) await a.call('answer_and_next', { examCode: `Q:${q}`, choiceIndex: 1, save: true });
  for (const expected of ['opened_sheet','verified_sheet','opened','confirmed']) assert.equal((await a.call('submit_current_exam', { examCode: 'Q:1' })).action, expected);
  for (let retry = 0; retry < 2; retry++) {
    const repeated = await a.call('submit_current_exam', { examCode: 'Q:1' });
    assert.equal(repeated.action, 'already_submitted');
    assert.equal(repeated.submissionApplied, false);
    assert.equal(repeated.nextAction, 'read_exam_result');
    assert.equal(a.sessions.get(17373).recoveryPending, null);
    assert.equal(effects.filter(x => x === 'submit').length, 4);
  }
  const saved = Object.values(storage).find(x => x.resumeToken === scope.resumeToken);
  assert.equal(saved.pendingAction, null);
  assert.equal(saved.submitted, true);
  a = boot(); await a.call('resume_scope', { resumeToken: scope.resumeToken });
  assert.equal((await a.call('submit_current_exam', { examCode: 'Q:1' })).action, 'already_submitted');
  assert.equal((await a.call('read_exam_result')).score.correct, 41);
  assert.equal((await a.call('open_answer_review', { resultToken: 'result-token', step: 'open', readAfter: false })).action, 'opened_review');
  assert.equal(effects.filter(x => x === 'submit').length, 4);
  // A genuinely uncertain mutation stays blocked, even if an earlier submission was confirmed.
  saved.pendingAction = 'open_answer_review';
  storage['practice-resume-v1:' + scope.resumeToken] = saved;
  a = boot(); await a.call('resume_scope', { resumeToken: scope.resumeToken });
  await assert.rejects(a.call('submit_current_exam', { examCode: 'Q:1' }), /uncertain outcome/);
  saved.pendingAction = null;
  storage['practice-resume-v1:' + scope.resumeToken] = saved;
  a = boot(); await a.call('resume_scope', { resumeToken: scope.resumeToken });
  // Simulated authorized next-attempt entry clears the old receipt/guard.
  await a.call('advance_subject');
  assert.equal(a.sessions.get(17373).submitted, false);
  assert.equal((await a.call('submit_current_exam', { examCode: 'Q:1' })).action, 'opened_sheet');
  throwSubmit = true;
  await assert.rejects(a.call('submit_current_exam', { examCode: 'Q:1' }), /connection lost/);
  await assert.rejects(a.call('open_answer_review', { resultToken: 'result-token', step: 'open' }), /uncertain outcome/);
}
console.log('INT repeated submit passed: confirmed -> duplicate -> result/review, checkpoint/reconnect, new attempt reset and uncertain mutations remain blocked (Normal and Loop)');
