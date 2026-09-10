import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const contentSource = readFileSync(new URL("extension/content-script.js", root), "utf8");
const workerSource = readFileSync(new URL("extension/service-worker.js", root), "utf8");
const origin = "https://main.virtualschool.club";
let mode = "list";
let listYear = "2569";
let courseYear = "2569";
const location = { hostname: "main.virtualschool.club", pathname: "/Course", href: `${origin}/Course?level=6&term=2&year=${listYear}&focus=22&isBackLevel=1` };
const navigate = (nextMode) => {
  mode = nextMode;
  location.pathname = nextMode === "list" ? "/Course" : "/StudyCourse";
  location.href = nextMode === "list"
    ? `${origin}/Course?level=6&term=2&year=${listYear}&focus=22&isBackLevel=1`
    : `${origin}/StudyCourse?code=22&subject=22&subjectCode=22&subj=22&level=J&selectedLevel=6&term=2&title=${encodeURIComponent("ชีววิทยา")}&year=${courseYear}&isBackLevel=1`;
};
const element = (innerText = "", options = {}) => ({
  innerText, disabled: false, title: options.title || "", style: {}, clicks: 0,
  getAttribute: name => options.attributes?.[name] ?? null,
  getClientRects: () => options.hidden ? [] : [1],
  classList: { contains: name => (options.classes || []).includes(name) },
  querySelector: selector => options.query?.(selector) || null,
  querySelectorAll: selector => options.queryAll?.(selector) || [],
  click() { this.clicks += 1; options.click?.(this); },
});
const title = element("ชีววิทยา");
const progress = element("90%");
const semester = element("ภาคเรียนที่ 2");
const finalStatus = element("Final: ยังไม่ผ่าน");
const cardButton = element("ดำเนินการต่อ", { click: () => navigate("course") });
const card = element("", { query: selector => ({
  "h3.card-title": title,
  ".prog-pct": progress,
  ".meta-chip": semester,
  ".final-status": finalStatus,
}[selector] || null), queryAll: selector => selector === "button.btn-primary" ? [cardButton] : [] });
const backButton = element("", { title: "ย้อนกลับ", click: () => navigate("list") });
const document = {
  body: element(""),
  querySelector: selector => selector === '.swal2-container, [role="dialog"][aria-modal="true"]' ? null : null,
  querySelectorAll: selector => {
    if (selector === ".card-body") return mode === "list" ? [card] : [];
    if (selector === 'button[title="ย้อนกลับ"]') return mode === "course" ? [backButton] : [];
    if (selector === "article") return [];
    if (selector === "button, a" || selector === "a, button") return mode === "list" ? [cardButton] : [backButton];
    return [];
  },
  getElementById: () => null,
};
let contentListener;
runInNewContext(contentSource, {
  URL,
  document,
  location,
  globalThis: {},
  setInterval: () => 0,
  chrome: { runtime: { sendMessage: async () => ({}), onMessage: { addListener: fn => { contentListener = fn; } } } },
});

let handler;
const sent = [];
class Socket {
  static OPEN = 1;
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}
const chrome = {
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  runtime: { getManifest: () => ({ version: "0.14.0" }), getURL: value => `chrome-extension://test/${value}`, onMessage: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 9, active: true, url: location.href }],
    sendMessage: async (id, message) => {
      sent.push({ id, ...message });
      if (message.action === "page_version") return { ok: true, result: { contentVersion: "0.14.0" } };
      let response;
      contentListener(message, null, value => { response = value; });
      return response;
    },
  },
};
runInNewContext(workerSource + "\nglobalThis.expose(handleRequest);", {
  chrome,
  WebSocket: Socket,
  URL,
  URLSearchParams,
  Date,
  console,
  crypto: { randomUUID: () => "worker-attempt" },
  setTimeout: (fn, ms) => { if (ms !== 1000) queueMicrotask(fn); return 1; },
  clearTimeout() {},
  setInterval() {},
  expose: fn => { handler = fn; },
});

const listed = await handler("read_subjects", {}, 17373);
assert.equal(listed.cards[0].subjectCode, undefined, "the compiled adapter keeps course identity opaque on the list");
assert.equal(listed.cards[0].cardToken.startsWith("virtual-card:"), true);
assert.equal(listed.listContext.level, "6");
assert.equal(listed.listContext.term, "2");
assert.equal(listed.listContext.year, "2569");
courseYear = "2570";
await assert.rejects(handler("open_subject", { listToken: listed.listToken, cardToken: listed.cards[0].cardToken }, 17373), /year/);
courseYear = "2569";
mode = "list";
location.pathname = "/Course";
location.href = `${origin}/Course?level=6&term=2&year=${listYear}&focus=22&isBackLevel=1`;
const opened = await handler("open_subject", { listToken: listed.listToken, cardToken: listed.cards[0].cardToken }, 17373);
assert.equal(opened.subjectCode, "22");
assert.equal(opened.course.level, "J", "the opened course keeps its opaque level separate from list level 6");
assert.equal(opened.course.subjectName, "ชีววิทยา");
assert.ok(sent.some(message => message.action === "open_subject" && message.cardToken && !("subjectCode" in message)));
await handler("set_scope", { subjectCode: "22", mode: "subject" }, 17373);
const returned = await handler("return_to_subjects", {}, 17373);
assert.equal(returned.action, "returned_to_subjects");
assert.equal(mode, "list");

const listedAgain = await handler("read_subjects", {}, 17373);
await handler("open_subject", { listToken: listedAgain.listToken, cardToken: listedAgain.cards[0].cardToken }, 17373);
await handler("set_scope", { subjectCode: "22", mode: "subject" }, 17373);
listYear = "2570";
await assert.rejects(handler("return_to_subjects", {}, 17373), /year/);

console.log("Compiled Virtual adapter/worker subject-list contract passed: listContext, null code until StudyCourse, opaque card token, selected-level transition and scoped return");
