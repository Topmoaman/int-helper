import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHistory } from '../src/history.mjs';
const content = readFileSync(new URL('../extension/content-script.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url))).version;
const el = (innerText = '', rest = {}) => ({ innerText, getClientRects: () => [1], querySelector: () => null, ...rest });
let number = 1, listener, changed;
const label = el('เวลาสอบ', { nextElementSibling: el('02:00:11', { tagName: 'P' }) });
const radio = { value: 'A', checked: false, nextElementSibling: el('A'), click() { this.checked = true; } };
const document = {
  documentElement: {}, body: el('รหัสข้อสอบ: EXAM ทั้งหมด 3 ข้อ'),
  querySelector: s => s === 'main h2' ? el(`ข้อคำถามที่ ${number}`) : s === '.exam-question' ? el('Q') : null,
  querySelectorAll: s => s === 'div' ? [label] : s === 'main input[type="radio"]' ? [radio] : [],
};
const origin = 'https://main.virtualschool.club';
const location = { hostname: 'main.virtualschool.club', pathname: '/Exam', href: origin + '/Exam?subject=BIO&level=6&term=1&year=2026&examtype=F' };
const scope = { origin, mode: 'final', subjectCode: 'BIO', level: '6', term: '1', year: '2026' };
class Observer { constructor(cb) { changed = cb; } observe() {} disconnect() { changed = null; } }
runInNewContext(content, { URL, document, location, setInterval: (fn, delay) => delay === 20000 ? 0 : setInterval(fn, delay),
  clearInterval, setTimeout, clearTimeout, MutationObserver: Observer,
  chrome: { runtime: { sendMessage: async () => {}, onMessage: { addListener: fn => { listener = fn; } } } } });
const call = message => new Promise(resolve => listener(message, null, resolve));
const envelope = request => ({ action: 'scoped_action', expectedContentVersion: version, request: { ...request, scope, expectedContentVersion: version } });
assert.ok((await call({ action: 'page_version' })).result.capabilities.includes('wait_question'));
const q = (await call(envelope({ action: 'read_question' }))).result;
assert.equal(q.examTimer.remainingSeconds, 7211);
const identity = await call({ action: 'page_identity', scope, expectedContentVersion: version });
assert.equal(identity.result.examCode, q.examCode);
const stale = await call({ ...envelope({ action: 'apply_answer', choiceIndex: 1, expectedExamCode: q.examCode }), expectedContentVersion: 'old' });
assert.equal(stale.ok, false); assert.equal(radio.checked, false, 'version rejection before mutation');
// Build a foreign request explicitly: envelope intentionally supplies its own scope.
const foreignMessage = envelope({ action: 'apply_answer', choiceIndex: 1, expectedExamCode: q.examCode });
foreignMessage.request.scope = { ...scope, subjectCode: 'FOREIGN' };
assert.equal((await call(foreignMessage)).ok, false); assert.equal(radio.checked, false);
const wait = call(envelope({ action: 'wait_question', previousExamCode: q.examCode }));
number = 2; changed();
const next = await wait; assert.equal(next.result.questionNumber, 2); assert.equal(changed, null);
const immediate = await call(envelope({ action: 'wait_question', previousExamCode: q.examCode }));
assert.equal(immediate.result.questionNumber, 2);

// Exercise the real worker against this compiled content, including guards.
let api, messages = [], fetches = 0;
class Socket { static OPEN = 1; readyState = 1; send() {} }
runInNewContext(worker + '\nexpose({sendScoped,waitForNext,checkpointPage,sessions,hydrateQuestion});', {
  chrome: { action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    tabs: { sendMessage: async (_id, message) => { messages.push(message.action); return call(message); } } },
  URL, WebSocket: Socket, setInterval() {}, setTimeout, clearTimeout, console,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  fetch: async () => { fetches++; return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; },
  expose: value => { api = value; },
});
const session = { port: 17373, tabId: 7, scope }; api.sessions.set(17373, session);
await api.sendScoped(session, { action: 'read_question' });
messages = [];
await api.sendScoped(session, { action: 'read_question' });
await api.checkpointPage(session);
await api.waitForNext(session, q.examCode);
assert.deepEqual(messages, ['scoped_action', 'page_identity', 'scoped_action'], 'one IPC per validated read/checkpoint/readiness');
const hydrated = await api.hydrateQuestion({ questionImage: 'https://example.test/a', choices: [{ index: 1, image: 'https://example.test/a' }] });
assert.equal(fetches, 1); assert.equal(hydrated.images.length, 2); assert.equal(hydrated.images[1].choiceIndex, 1);
await api.hydrateQuestion({ questionImage: 'https://example.test/a' });
assert.equal(fetches, 2, 'no reuse of potentially stale completed bytes');

// Local cache must not hide foreign rewrites, truncation or new evidence.
const dir = mkdtempSync(join(tmpdir(), 'history-cache-contract-'));
try {
  const history = createHistory(dir, { ...scope, subjectName: 'Biology' });
  const question = { questionText: 'Q', choices: [{ index: 1, text: 'A' }, { index: 2, text: 'B' }] };
  history.append({ type: 'question', question }); history.lookup(question);
  for (let i = 0; i < 20; i++) { history.append({ type: 'question', question }); history.lookup(question); }
  assert.equal(history.stats().questionReadRecords, 21);
  const lines = readFileSync(history.file, 'utf8');
  const base = JSON.parse(lines.split('\n')[0]);
  const verified = { ...base, type: 'verified_answer', question, correctChoice: question.choices[1], verificationSource: 'Virtual School explicit correct-answer label' };
  writeFileSync(history.file, JSON.stringify(verified) + '\n');
  assert.equal(history.lookup(question).choiceIndex, 2, 'truncation and new evidence rebuild');
  const replacement = history.file + '.replacement';
  writeFileSync(replacement, JSON.stringify({ ...verified, correctChoice: question.choices[0] }) + '\n');
  renameSync(replacement, history.file);
  assert.equal(history.lookup(question).choiceIndex, 1, 'replacement rebuilds even at equal size');
  history.append({ type: 'question', question });
  assert.equal(history.stats().questionReadRecords, 1);
  assert.equal(createHistory(dir, { ...scope, subjectName: 'Biology' }).lookup(question).choiceIndex, 1, 'durable history survives fresh reader');
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Latency contract passed: compiled Virtual timer/readiness/envelope, scope/version fail-before-action, actual worker 3 operations/3 IPC, in-flight image coalescing, durable history counters and external rewrite/truncation recovery');
