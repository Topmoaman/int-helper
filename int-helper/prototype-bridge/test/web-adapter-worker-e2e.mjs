import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("..", import.meta.url);
const contentSource = readFileSync(new URL("extension/content-script.js", root), "utf8");
const workerSource = readFileSync(new URL("extension/service-worker.js", root), "utf8");
const origin = "https://main.virtualschool.club";
const port = 17373;

class Element {
  constructor({ text = "", attrs = {}, lists = {}, onClick = null } = {}) {
    this.innerText = text;
    this.attrs = attrs;
    this.lists = lists;
    this.onClick = onClick;
    this.disabled = false;
    this.classList = { contains: (name) => String(attrs.class || "").split(/\s+/u).includes(name) };
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  querySelector(selector) { return this.lists[selector]?.[0] || null; }
  querySelectorAll(selector) { return this.lists[selector] || []; }
  getClientRects() { return [1]; }
  click() { this.onClick?.(); }
}

const state = { mode: "list", progress: "90%", focus: "22" };
const location = { hostname: "main.virtualschool.club", pathname: "/Course", href: `${origin}/Course?level=6&term=2&focus=22&isBackLevel=1` };
const setLocation = (url) => {
  const parsed = new URL(url);
  location.pathname = parsed.pathname;
  location.href = parsed.href;
};
const courseUrl = () => `${origin}/StudyCourse?code=22&subject=22&subjectCode=22&subj=22&level=J&selectedLevel=6&term=2&year=2569&title=ชีววิทยา+(หลักสูตรปรับปรุง+2560)&progress=&classx=6`;
const makeCards = () => {
  const make = (caption, progress, actionText, onClick) => {
    const button = new Element({ text: actionText, attrs: { class: "btn-primary" }, onClick });
    return new Element({ lists: {
      "h3.card-title": [new Element({ text: caption })],
      ".prog-pct": [new Element({ text: progress })],
      ".final-status": [new Element({ text: "Final: ยังไม่ผ่าน" })],
      ".final-status > .final--fail": [new Element({ text: "ยังไม่ผ่าน" })],
      ".meta-chip": [new Element({ text: "ภาคเรียนที่ 2" })],
      "button.btn-primary": [button],
    } });
  };
  return [
    make("ภาษาไทย", "0%", "เริ่มเรียน", () => {}),
    make("ชีววิทยา (หลักสูตรปรับปรุง 2560)", state.progress, "ดำเนินการต่อ", () => {
      state.mode = "study";
      setLocation(courseUrl());
    }),
    make("โลก ดาราศาสตร์ และอวกาศ (เพิ่มเติม 60)", "75%", "ดำเนินการต่อ", () => {}),
  ];
};
const back = new Element({ attrs: { title: "ย้อนกลับ" }, onClick: () => {
  state.mode = "list";
  setLocation(`${origin}/Course?level=6&term=2&focus=${state.focus}`);
} });
const document = {
  body: new Element({ text: "" }),
  querySelector(selector) {
    if (state.mode === "study" && selector === 'button[title="ย้อนกลับ"]') return back;
    return null;
  },
  querySelectorAll(selector) {
    if (state.mode === "list" && selector === ".card-body") return makeCards();
    if (state.mode === "list" && selector === "button, a") return makeCards().map((card) => card.querySelector("button.btn-primary"));
    if (state.mode === "study" && selector === 'button[title="ย้อนกลับ"]') return [back];
    if (state.mode === "study" && selector === "button, a") return [back];
    if (selector === "article") return [];
    return [];
  },
};

let contentListener;
const contentChrome = {
  runtime: {
    sendMessage: () => ({ catch() {} }),
    onMessage: { addListener(listener) { contentListener = listener; } },
  },
};
runInNewContext(contentSource, {
  chrome: contentChrome,
  document,
  location,
  URL,
  URLSearchParams,
  console,
  setInterval() {},
  globalThis: {},
});
assert.equal(typeof contentListener, "function");
const sendToContent = (message) => new Promise((resolve) => contentListener(message, {}, resolve));

const sent = [];
let handler;
class Socket {
  static OPEN = 1;
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}
const chrome = {
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  runtime: { getManifest: () => ({ version: "0.15.1" }), getURL: (value) => `chrome-extension://test/${value}`, onMessage: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 7, active: true, url: location.href }],
    sendMessage: async (id, message) => {
      sent.push({ id, ...message });
      return sendToContent(message);
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
  crypto: { randomUUID: () => "e2e-binding" },
  setTimeout,
  clearTimeout,
  setInterval() {},
  expose: (fn) => { handler = fn; },
});

const listed = await handler("read_subjects", {}, port);
assert.equal(listed.cards.length, 3);
assert.equal(Object.prototype.hasOwnProperty.call(listed.cards[1], "subjectCode"), false);
const opened = await handler("open_subject", { listToken: listed.listToken, cardToken: listed.cards[1].cardToken }, port);
assert.equal(opened.subjectCode, "22");
assert.equal(opened.course.subjectName, "ชีววิทยา (หลักสูตรปรับปรุง 2560)");
assert.ok(sent.some((message) => message.action === "open_subject" && message.cardToken === listed.cards[1].cardToken && !Object.hasOwn(message, "subjectCode")));

const scoped = await handler("set_scope", { subjectCode: "22", mode: "subject" }, port);
assert.equal(scoped.scope.level, "J");
const returned = await handler("return_to_subjects", {}, port);
assert.equal(returned.action, "returned_to_subjects");
assert.equal(state.mode, "list");

console.log("Compiled content-to-worker adapter E2E passed: Virtual cards, opaque opening, StudyCourse identity, scoped return and list restoration");

