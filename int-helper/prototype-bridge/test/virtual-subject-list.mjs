import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workerSource = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const origin = "https://main.virtualschool.club";
const port = 17373;
let handler;
let pageState = "list";
let focus = "22";
let progress = 90;
let action = "ดำเนินการต่อ";
let caption = "ชีววิทยา";
let selectedLevel = "6";
let selectedSubjectCode = "22";
let duplicate = false;
let exposeCode = false;
let disconnectOnOpen = false;
const sent = [];

const listResult = () => {
  const cards = [
    { cardToken: "opaque-biology", caption, progress, action, disabled: false },
    { cardToken: "opaque-physics", caption: "ฟิสิกส์", progress: 0, action: "เริ่มเรียน", disabled: false },
  ];
  if (duplicate) cards[1].cardToken = cards[0].cardToken;
  if (exposeCode) cards[0].subjectCode = "must-not-leak";
  return { origin, listToken: progress === 75 ? "course-list-token-refresh" : "course-list-token", level: "6", term: "2", cards };
};
const pageInfo = () => pageState === "list"
  ? { origin, path: "/Course", url: `${origin}/Course?level=6&term=2&focus=${focus}&isBackLevel=1` }
  : { origin, path: "/StudyCourse", url: `${origin}/StudyCourse?subject=${selectedSubjectCode}&subjectCode=${selectedSubjectCode}&level=J&selectedLevel=${selectedLevel}&term=2&year=2569`,
    course: { subjectCode: selectedSubjectCode, subjectName: caption, level: "J", term: "2", year: "2569", selectedLevel }, chapters: [] };

class Socket {
  static OPEN = 1;
  readyState = 1;
  constructor() { this.onclose = null; }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}
const chrome = {
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  runtime: { getManifest: () => ({ version: "test" }), getURL: value => `chrome-extension://test/${value}`, onMessage: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 7, active: true, url: pageInfo().url }],
    sendMessage: async (id, message) => {
      sent.push({ id, ...message });
      if (message.action === "page_version") return { ok: true, result: { contentVersion: "test" } };
      if (message.action === "inspect_page") return { ok: true, result: pageInfo() };
      if (message.action === "read_subjects") return { ok: true, result: listResult() };
      if (message.action === "open_subject") {
        if (disconnectOnOpen) sockets[0]?.close();
        pageState = "course";
        return { ok: true, result: { action: "opened_subject" } };
      }
      if (message.action === "return_to_subjects") {
        pageState = "list";
        return { ok: true, result: { action: "returned_to_subjects" } };
      }
      return { ok: true, result: {} };
    },
  },
};
const sockets = [];
runInNewContext(workerSource + "\nglobalThis.expose(handleRequest);", {
  chrome,
  WebSocket: class extends Socket { constructor(...args) { super(...args); sockets.push(this); } },
  URL,
  URLSearchParams,
  Date,
  console,
  crypto: { randomUUID: () => "worker-token" },
  setTimeout: (fn, ms) => { if (ms !== 1000) queueMicrotask(fn); return 1; },
  clearTimeout() {},
  setInterval() {},
  expose: fn => { handler = fn; },
});

const read = () => handler("read_subjects", {}, port);
const open = cardToken => handler("open_subject", { listToken: "course-list-token", cardToken }, port);

let listed = await read();
assert.equal(listed.origin, origin);
assert.equal(listed.cards[0].cardToken, "opaque-biology");
assert.equal(listed.cards[0].subjectCode, undefined);

// Focus/isBackLevel and progress are not list identity. The worker rechecks
// the changed card's progress/action and still opens the same opaque token.
focus = "99";
progress = 75;
let opened = await open("opaque-biology");
assert.equal(opened.subjectCode, "22");
assert.equal(opened.course.level, "J");
assert.equal(opened.course.selectedLevel, "6");
assert.ok(sent.find(message => message.action === "open_subject" && message.cardToken === "opaque-biology" &&
  message.listToken === "course-list-token-refresh" && !("subjectCode" in message)));

// Opening consumed the list but preserves the verified context for a scoped
// return. Setting a different subject in the same tab cannot use its back
// button.
await handler("set_scope", { subjectCode: "22", mode: "subject" }, port);
selectedSubjectCode = "different";
await assert.rejects(handler("return_to_subjects", {}, port), /does not match the opened scoped subject/);
selectedSubjectCode = "22";
const returned = await handler("return_to_subjects", {}, port);
assert.equal(returned.action, "returned_to_subjects");
assert.equal(pageState, "list");

// Re-read the list for stale/progress/disabled/identity checks.
progress = 90;
action = "ดำเนินการต่อ";
listed = await read();
caption = "ชีววิทยา (renamed)";
await assert.rejects(open("opaque-biology"), /Subject list changed/);
caption = "ชีววิทยา";
progress = null;
await assert.rejects(open("opaque-biology"), /progress is unknown/);
progress = 90;
action = "disabled";
await assert.rejects(open("opaque-biology"), /disabled/);
action = "ดำเนินการต่อ";
duplicate = true;
await assert.rejects(read(), /ambiguous/);
duplicate = false;
exposeCode = true;
await assert.rejects(read(), /opaque cardToken/);
exposeCode = false;

// A disconnect while the asynchronous StudyCourse wait is in flight expires
// the saved list before the worker can commit it.
listed = await read();
disconnectOnOpen = true;
await assert.rejects(open("opaque-biology"), /expired/);
disconnectOnOpen = false;

console.log("Virtual subject-list worker passed: opaque card tokens, selected-level transition, progress/action revalidation, stale/duplicate/disabled refusal, scoped return and disconnect expiry");
