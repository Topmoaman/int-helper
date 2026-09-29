import assert from 'node:assert/strict';
import { waitForReady } from '../src/web-adapters/readiness.mjs';
import { readVirtualTimer } from '../src/web-adapters/virtual-timer.mjs';

let observers = [], disconnects = 0;
class Observer {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() { disconnects++; }
}
const document = { documentElement: {} };
let current = { examCode: 'old', saving: false };
const ready = q => q.examCode === 'next' && !q.saving;
const read = () => current;
current = { examCode: 'next', saving: false };
assert.equal(await waitForReady({ document, read, ready, Observer }), current);
assert.equal(observers.length, 0, 'already-ready question does not allocate timers or observer');
current = { examCode: 'old' };
const pending = waitForReady({ document, read, ready, Observer, intervalMs: 10000 });
current = { examCode: 'next', saving: true }; observers.at(-1).callback();
current = { examCode: 'next', saving: false }; observers.at(-1).callback();
assert.equal(await pending, current); assert.equal(disconnects, 1);
current = { examCode: 'old' };
let failed = false;
const rejected = waitForReady({ document, read: () => { if (failed) throw Error('Scope expired'); return current; }, ready, Observer });
failed = true; observers.at(-1).callback();
await assert.rejects(rejected, /Scope expired/); assert.equal(disconnects, 2);
await assert.rejects(waitForReady({ document, read, ready, Observer, timeoutMs: 5 }), /Timed out/);
assert.equal(disconnects, 3);
const fallback = waitForReady({ document, read, ready, Observer: null, intervalMs: 2 });
current = { examCode: 'next' }; await fallback;
// Mutation during observer registration must be caught by the second read.
current = { examCode: 'old' };
class RaceObserver extends Observer { observe() { current = { examCode: 'next' }; } }
await waitForReady({ document, read, ready, Observer: RaceObserver });

const node = (innerText, tagName = 'DIV') => ({ innerText, tagName, getClientRects: () => [1] });
const label = node(' เวลาสอบ '), timer = node('02:00:11', 'P'); label.nextElementSibling = timer;
let labels = [label];
const timerDocument = { querySelectorAll: () => labels };
const final = { href: 'https://main.virtualschool.club/Exam?examtype=F' };
assert.equal(readVirtualTimer(timerDocument, final).remainingSeconds, 7211);
for (const value of ['02:00:01', '01:50:00', '00:00:00']) {
  timer.innerText = value; assert.equal(readVirtualTimer(timerDocument, final).display, value);
}
for (const value of ['01:60:00', 'loading', '', '01:50']) {
  timer.innerText = value; assert.equal(readVirtualTimer(timerDocument, final).available, false);
}
timer.innerText = '01:50:00';
assert.equal(readVirtualTimer(timerDocument, { href: 'https://main.virtualschool.club/Exam?examtype=A' }).reason, 'not_final_countdown');
labels = [label, label]; assert.equal(readVirtualTimer(timerDocument, final).available, false);
labels = []; assert.equal(readVirtualTimer(timerDocument, final).available, false);
labels = [label]; timer.getClientRects = () => []; assert.equal(readVirtualTimer(timerDocument, final).available, false);
console.log('Readiness/timer passed: immediate, observed, timeout, scope failure, cleanup, property fallback, registration race; Virtual rendered final timer >2h, invalid/hidden/duplicate/non-final refusal');
