import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistory } from "../src/history.mjs";
import { runInNewContext } from "node:vm";

const sourcePath = process.argv[2] || new URL("../extension/content-script.js", import.meta.url);
const source = readFileSync(sourcePath, "utf8");
const base = "https://main.virtualschool.club";
const course = "?subject=MATH&level=2&term=1&year=2026";
const scope = { mode: "chapter", origin: base, subjectCode: "MATH", level: "2", term: "1", year: "2026", chapter: 1, chapterTitle: "จำนวน" };

const element = (innerText = "", options = {}) => {
  const classes = new Set(options.classes || []);
  return {
    innerText, disabled: false, clicks: 0, title: options.title || "",
    getAttribute: (name) => options.attributes?.[name] ?? null,
    getClientRects: () => options.hidden ? [] : [1],
    classList: { contains: (name) => classes.has(name) },
    querySelector: (selector) => options.query?.(selector) || null,
    querySelectorAll: (selector) => options.queryAll?.(selector) || [],
    click() { this.clicks++; if (options.click) options.click(this); },
    ...options,
  };
};

const start = ({ path = "/Exam", query = course, bodyText = "รหัสข้อสอบ: EXAM", question = null, image = null, radios = [], controls = [], articles = [], dialog = null, origin = base, selectors = {}, lists = {} } = {}) => {
  let listener;
  const document = {
    body: element(bodyText),
    getElementById(id) { return selectors[`#${id}`] || null; },
    querySelector(selector) {
      if (selector in selectors) return selectors[selector];
      if (selector === "main h2") return question?.heading || null;
      if (selector === ".exam-question") return question?.node || null;
      if (selector === 'main img[src*="/question_pic/"]') return image;
      if (selector === '.swal2-container, [role="dialog"][aria-modal="true"]') return dialog;
      return null;
    },
    querySelectorAll(selector) {
      if (selector in lists) return lists[selector];
      if (selector === 'main input[type="radio"]') return radios;
      if (selector === "button, a" || selector === "a, button") return controls;
      if (selector === "article") return articles;
      return [];
    },
  };
  runInNewContext(source, {
    URL, document, globalThis: {}, setInterval: () => 0,
    location: { hostname: new URL(origin).hostname, pathname: path, href: `${origin}${path}${query}` },
    chrome: { runtime: { sendMessage: async () => {}, onMessage: { addListener: (fn) => { listener = fn; } } } },
  });
  return (message) => {
    let response;
    listener(message, null, (value) => { response = value; });
    return response;
  };
};

const radio = (value) => ({ value, checked: false, nextElementSibling: element(value), click() { this.checked = true; } });
const exam = ({ number = 1, count = 2, imageOnly = false, bodyText, radios = [radio("ก"), radio("ข")] } = {}) => ({
  question: { heading: element(`ข้อคำถามที่ ${number}`), node: imageOnly ? null : element("โจทย์") },
  image: imageOnly ? element("", { currentSrc: `${base}/question_pic/q.jpg`, src: "/question_pic/q.jpg" }) : null,
  radios,
  bodyText: bodyText || `รหัสข้อสอบ: EXAM ทั้งหมด ${count} ข้อ`,
});

const assertError = (response, pattern) => {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.match(response.error, pattern);
};

// The site sometimes renders diagram questions without .exam-question.
{
  const page = start({ ...exam({ imageOnly: true }), path: "/Exam", query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  const read = page({ action: "read_question" });
  assert.equal(read.ok, true, read.error);
  assert.equal(read.result.questionImage, `${base}/question_pic/q.jpg`);
  assert.equal(page({ action: "advance_subject", scope }).result.mode, "exam");
}

// A blank /Exam is still loading, never a completed result.
{
  const page = start({ bodyText: "กำลังโหลด", query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  assert.equal(page({ action: "advance_subject", scope }).result.mode, "exam");
  assertError(page({ action: "read_question" }), /not ready/);
}

// Scope is a hard gate for every state-changing command.
{
  const r = [radio("ก")];
  const page = start({ ...exam({ radios: r }), query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  for (const action of ["apply_answer", "navigate_next", "advance_subject", "submit_exam"]) {
    const response = page({ action, choiceIndex: 1, expectedExamCode: "EXAM:1" });
    assertError(response, /explicit scope/);
  }
  assert.equal(r[0].checked, false);
}

// Course identity and the Content lesson title must agree exactly with the requested scope.
for (const [key, value] of [["subject", "SCI"], ["term", "2"], ["year", "2025"]]) {
  const params = new URLSearchParams(`${course.slice(1)}&chapter=1&SUB_SUBJECT_NAME=จำนวน`);
  params.set(key, value);
  const page = start({ ...exam(), query: `?${params}` });
  assertError(page({ action: "advance_subject", scope }), /Scope mismatch|Conflicting/);
}
{
  const page = start({ path: "/Content", query: `${course}&lessonTitle=เรขาคณิต` });
  assertError(page({ action: "advance_subject", scope }), /Lesson is outside/);
}

const card = ({ number, title, complete = false, topic = true }) => {
  const header = element(`บทที่ ${number} ${title}`, { query: (s) => s === "h4" ? element(title) : null });
  const pre = element("ก่อนเรียน", { classes: complete ? ["bg-emerald-500"] : [] });
  const post = element("หลังเรียน", { classes: complete ? ["bg-emerald-500"] : [] });
  const lesson = element("เรื่องที่ 1", { attributes: { "aria-label": "เปิดบทเรียน: เรื่องที่ 1" }, query: (s) => complete && s === "svg.text-emerald-500" ? element() : null });
  const local = topic ? [header, pre, lesson, post] : [header];
  const body = complete ? "ผ่านเกณฑ์หน่วยเรียนแล้ว" : "กำลังเรียน";
  return element(body, {
    query: (s) => s === "button" ? header : s === 'button[aria-label^="เปิดบทเรียน:"]' ? (topic ? lesson : null) : null,
    queryAll: (s) => s === "button, a" ? local : s === 'button[aria-label^="เปิดบทเรียน:"]' ? (topic ? [lesson] : []) : [],
    card: { header, pre, post, lesson },
  });
};

// Cards have no aria-expanded and several may be open. Only the scoped article may be touched.
{
  const first = card({ number: 1, title: "จำนวน" });
  const second = card({ number: 2, title: "เรขาคณิต" });
  second.card.pre.click = () => assert.fail("clicked chapter 2");
  second.card.lesson.click = () => assert.fail("clicked chapter 2 lesson");
  const globalCta = element("ทำแบบทดสอบปลายภาค", { click: () => assert.fail("clicked global CTA") });
  const page = start({ path: "/StudyCourse", bodyText: "ความคืบหน้า 40%", controls: [globalCta], articles: [first, second] });
  const result = page({ action: "advance_subject", scope }).result;
  assert.deepEqual({ action: result.action, chapter: result.chapter }, { action: "opened", chapter: 1 });
  assert.equal(first.card.pre.clicks, 1);
  assert.equal(second.card.header.clicks, 0);
}

// Once chapter 1 is complete, chapter mode stops before considering chapter 2 or a global CTA.
{
  const first = card({ number: 1, title: "จำนวน", complete: true });
  const second = card({ number: 2, title: "เรขาคณิต" });
  second.card.pre.click = () => assert.fail("advanced into chapter 2");
  const cta = element("ทำแบบทดสอบปลายภาค", { click: () => assert.fail("clicked global CTA") });
  const page = start({ path: "/StudyCourse", controls: [cta], articles: [first, second] });
  assert.deepEqual(page({ action: "advance_subject", scope }).result.mode, "chapter_complete");
  assert.equal(second.card.pre.clicks, 0);
}

// Checking the last visible question is insufficient: every token must have been observed via apply_answer.
{
  const r = [radio("ก"), radio("ข")]; r[1].checked = true;
  const state = exam({ number: 2, count: 2, radios: r });
  const page = start({ ...state, query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  assertError(page({ action: "submit_exam", expectedExamCode: "EXAM:2", scope }), /Not every answer/);
}

// A verified ledger permits ordinary submission and its known confirmation.
{
  const state = exam({ count: 2 });
  const controls = [];
  const page = start({ ...state, controls, query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  const first = page({ action: "apply_answer", choiceIndex: 1, expectedExamCode: "EXAM:1", save: true, scope }).result;
  assert.equal(first.saved, null);
  assert.equal(first.persistence, "unverified_until_submission");
  state.question.heading.innerText = "ข้อคำถามที่ 2";
  page({ action: "apply_answer", choiceIndex: 2, expectedExamCode: "EXAM:2", scope });
  const submit = element("ส่งคำตอบ");
  controls.push(submit);
  assert.equal(page({ action: "submit_exam", expectedExamCode: "EXAM:2", scope }).result.action, "opened");
  assert.equal(submit.clicks, 1);
  assertError(page({ action: "submit_exam", expectedExamCode: "WRONG", scope }), /stale exam/);
}
{
  const confirm = element("ยืนยันการส่ง");
  const dialog = element("ยืนยันการส่งคำตอบ", { queryAll: () => [confirm] });
  const page = start({ ...exam({ count: 1 }), dialog, query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  page({ action: "apply_answer", choiceIndex: 1, expectedExamCode: "EXAM:1", scope });
  assert.equal(page({ action: "submit_exam", expectedExamCode: "EXAM:1", scope }).result.action, "confirmed");
  assert.equal(confirm.clicks, 1);
}

// advance_subject reports dialogs but never submits; unknown submission dialogs are rejected untouched.
{
  const dangerous = element("ยืนยัน", { click: () => assert.fail("advance_subject confirmed submission") });
  const dialog = element("ยืนยันการส่งคำตอบ", { queryAll: () => [dangerous] });
  const page = start({ ...exam(), query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน`, dialog });
  assert.equal(page({ action: "advance_subject", scope }).result.action, "confirmation_required");
  assert.equal(dangerous.clicks, 0);
  const unknown = element("unexpected", { queryAll: () => [dangerous] });
  const blocked = start({ ...exam({ count: 1 }), query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน`, dialog: unknown });
  blocked({ action: "apply_answer", choiceIndex: 1, expectedExamCode: "EXAM:1", scope });
  assertError(blocked({ action: "submit_exam", expectedExamCode: "EXAM:1", scope }), /Unknown submission dialog/);
  assert.equal(dangerous.clicks, 0);
}

// Submitted results are terminal for submit_exam and must never hit a lingering submit button.
{
  const submit = element("ส่งคำตอบ", { click: () => assert.fail("resubmitted") });
  const page = start({ bodyText: "ส่งคำตอบเรียบร้อยแล้ว รหัสข้อสอบ: EXAM", controls: [submit], query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  assert.equal(page({ action: "submit_exam", expectedExamCode: "EXAM:1", scope }).result.action, "already_submitted");
  assert.equal(submit.clicks, 0);
}

console.log(`regression passed: ${sourcePath}`);

// Exercise the actual worker with Chrome/socket boundaries mocked; no live account is touched.
{
  const sockets = [];
  let activeTab = 1, version = "0.12.0", handler, popupListener, delayHook, held;
  const sent = [];
  let selectionResult = { examCode: "EXAM:1", selected: 2, saved: null, persistence: "unverified_until_submission" };
  let readResult = () => ({ examCode: "EXAM:2", choices: [], images: [] });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { sockets.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose(); }
  }
  const pageInfo = { origin: base, course: { subjectCode: "MATH", level: "2", term: "1", year: "2026" }, chapters: [{ number: 1, title: "จำนวน" }] };
  let advance = () => ({ mode: "chapter_complete", chapter: 1 });
  const chrome = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    runtime: { getManifest: () => ({ version: "0.12.0" }), getURL: (p) => `chrome-extension://test/${p}`, onMessage: { addListener: (fn) => { popupListener = fn; } } },
    tabs: {
      query: async () => [{ id: activeTab, active: true, url: `${base}/StudyCourse` }],
      sendMessage: async (id, message) => {
        sent.push({ id, ...message });
        if (message.action === "page_version") return { ok: true, result: { contentVersion: version } };
        if (message.action === "bind_current_exam") return { ok: true, result: { mode: "exam", origin: base, examBinding: message.examBinding, submissionAllowed: message.allowSubmit === true } };
        if (message.action === "inspect_page") return { ok: true, result: pageInfo };
        if (message.action === "read_subjects") return { ok: true, result: { listToken: "subjects-term2", subjects: [] } };
        if (message.action === "advance_subject") {
          try { return { ok: true, result: await advance() }; }
          catch (error) { return { ok: false, error: error.message }; }
        }
        if (message.action === "apply_answer") return { ok: true, result: selectionResult };
        if (message.action === "navigate_next") return { ok: true, result: { done: false } };
        if (message.action === "read_question") return { ok: true, result: readResult() };
        return { ok: true, result: { action: "confirmed" } };
      },
    },
  };
  runInNewContext(readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8") + "\nglobalThis.expose(handleRequest);", {
    chrome, WebSocket: Socket, Date, URL, console, crypto: { randomUUID: () => "worker-binding" },
    setTimeout: (fn, ms) => { if (ms !== 1000 && ms !== 1500) queueMicrotask(() => { delayHook?.(); fn(); }); return 1; },
    clearTimeout() {}, setInterval() {},
    expose: (fn) => { handler = fn; },
  });
  await assert.rejects(handler("advance_subject", {}, 17373), /Set automation scope/);
  await assert.rejects(handler("open_subject", { listToken: "subjects-term2", subjectCode: "MATH" }, 17373), /Read the subject list/);
  await handler("read_subjects", {}, 17373);
  activeTab = 2;
  sent.length = 0;
  await assert.rejects(handler("open_subject", { listToken: "changed", subjectCode: "MATH" }, 17373), /Read the subject list/);
  await handler("open_subject", { listToken: "subjects-term2", subjectCode: "MATH" }, 17373);
  assert.ok(sent.every(message => message.id === 1), "subject entry must pin the inspected tab");
  await assert.rejects(handler("open_subject", { listToken: "subjects-term2", subjectCode: "MATH" }, 17373), /Read the subject list/);
  await assert.rejects(handler("advance_subject", {}, 17373), /Set automation scope/);
  activeTab = 1;
  const setup = () => handler("set_scope", { subjectCode: "MATH", mode: "chapter", chapter: 1 }, 17373);
  await setup();
  activeTab = 2;
  sent.length = 0;
  assert.equal((await handler("complete_current_lesson", {}, 17373)).mode, "chapter_complete");
  assert.equal(sent.filter((m) => m.action === "advance_subject").length, 1);
  assert.ok(sent.every((m) => m.id === 1), "scope must pin its original tab");
  let loadingAttempts = 0;
  advance = () => {
    if (++loadingAttempts <= 2) throw new Error("Chapter overview is loading");
    return { mode: "chapter_complete", chapter: 1 };
  };
  assert.equal((await handler("complete_current_lesson", {}, 17373)).mode, "chapter_complete");
  assert.equal(loadingAttempts, 3);
  advance = () => { throw new Error("Target chapter cannot be identified"); };
  await assert.rejects(handler("complete_current_lesson", {}, 17373), /Target chapter/);
  advance = () => ({ mode: "submission", action: "confirmation_required" });
  assert.equal((await handler("complete_current_lesson", {}, 17373)).actions, 1);
  const answered = await handler("answer_and_next", { choiceIndex: 2, examCode: "EXAM:1", save: true }, 17373);
  assert.equal(answered.examCode, "EXAM:2");
  assert.equal(answered.answeredExamCode, "EXAM:1");
  assert.equal(answered.saved, null);
  assert.equal(answered.persistence, "unverified_until_submission");
  await assert.rejects(handler("submit_current_exam", {}, 17373), /exact examCode/);
  version = "0.2.7";
  const before = sent.filter((m) => m.action === "advance_subject").length;
  await assert.rejects(handler("advance_subject", {}, 17373), /reloading/);
  assert.equal(sent.filter((m) => m.action === "advance_subject").length, before);
  version = "0.12.0";
  advance = () => new Promise((resolve) => { held = resolve; });
  const running = handler("advance_subject", {}, 17373);
  while (!held) await Promise.resolve();
  await assert.rejects(handler("answer_and_next", {}, 17373), /already running/);
  await assert.rejects(setup(), /running action/);
  held({ mode: "lesson", action: "waiting" });
  await running;
  // Losing the bridge while a batch waits cancels its next action.
  advance = () => ({ mode: "lesson", action: "waiting" });
  delayHook = () => { sockets[0].close(); delayHook = null; };
  sent.length = 0;
  await assert.rejects(handler("complete_current_lesson", {}, 17373), /Scope expired/);
  assert.equal(sent.filter((m) => m.action === "advance_subject").length, 1);
  await assert.rejects(handler("advance_subject", {}, 17373), /Set automation scope/);
  assert.equal(popupListener({ action: "bridge_status" }, { url: `${base}/Exam` }, () => assert.fail("unauthorized popup access")), undefined);
  const status = () => new Promise((resolve) => popupListener({ action: "bridge_status" }, { url: chrome.runtime.getURL("popup.html") }, resolve));
  assert.equal((await status()).page, "ready");
  version = "0.2.7";
  assert.equal((await status()).page, "reload");
  version = "0.12.0";
  pageInfo.path = "/StudyCourse";
  await handler("set_scope", { subjectCode: "MATH", mode: "final" }, 17373);
  pageInfo.path = "/Exam";
  await assert.rejects(handler("set_scope", { subjectCode: "MATH", mode: "final" }, 17373), /course overview/);
  Object.assign(pageInfo, { origin: "https://int-project.com", path: "/student/virtual_school/index.php", course: { subjectCode: "q294", level: "6", term: "2", year: "s294w2d4", subjectName: "ภาษาอังกฤษ" }, chapters: [{ number: 1, title: "Speaking" }] });
  await handler("set_scope", { subjectCode: "q294", mode: "chapter", chapter: 1 }, 17373);
  advance = () => ({ mode: "overview", action: "opened", intActivity: { kind: "exam", chapter: 1, title: "Speaking", examType: "A" } });
  await handler("advance_subject", {}, 17373);
  selectionResult = { examCode: "INT-LAST", autoAdvance: true, lastQuestion: true, saved: null };
  readResult = () => ({ examCode: "INT-FIRST", saving: false, choices: [] });
  sent.length = 0;
  const last = await handler("answer_and_next", { examCode: "INT-LAST", choiceIndex: 3, save: true }, 17373);
  assert.equal(last.done, true);
  assert.equal(last.examCode, "INT-FIRST");
  assert.equal(last.answeredExamCode, "INT-LAST");
  assert.equal(sent.filter((m) => m.action === "navigate_next").length, 0, "INT Save must never cause a second navigation");
  assert.equal(sent.find((m) => m.action === "apply_answer").scope.intActivity.chapter, 1);
  let reads = 0;
  selectionResult = { ...selectionResult, examCode: "SINGLE" };
  readResult = () => ({ examCode: "SINGLE", saving: ++reads < 3, choices: [] });
  assert.equal((await handler("answer_and_next", { examCode: "SINGLE", choiceIndex: 1, save: true }, 17373)).done, true);
  assert.equal(reads, 3, "one-question exam must wait for its save acknowledgement");
  readResult = () => ({ examCode: "SINGLE", saving: true, choices: [] });
  await assert.rejects(handler("answer_and_next", { examCode: "SINGLE", choiceIndex: 1, save: true }, 17373), /Timed out/);
  await handler("set_scope", { subjectCode: "q294", mode: "final" }, 17373);
  advance = () => ({ mode: "result", action: "returned", intActivity: { kind: "exam", examType: "F", finalResult: { correct: 3, total: 50, passed: false } } });
  await handler("advance_subject", {}, 17373);
  advance = () => ({ mode: "complete", finalResult: { correct: 3, total: 50, passed: false } });
  assert.equal((await handler("complete_current_lesson", {}, 17373)).finalResult.passed, false);
  assert.equal(sent.at(-1).scope.intActivity.examType, "F");
  const beforeToggle = sent.length;
  const looping = await handler("set_exam_loop", { enabled: true }, 17373);
  assert.equal(looping.loopMode, "loop_until_50");
  assert.equal(looping.scope.intActivity.finalResult.correct, 3);
  const normal = await handler("set_exam_loop", { enabled: false }, 17373);
  assert.equal(normal.scope.retryUntilPerfect, false);
  assert.equal(normal.scope.intActivity.finalResult.correct, 3);
  assert.equal(sent.length, beforeToggle);
  await assert.rejects(handler("set_exam_pacing", { durationMinutes: -1 }, 17373), /between/);
  await handler("set_exam_pacing", { durationMinutes: 60 }, 17373);
  let startedAt = Date.now();
  advance = () => ({ mode: "overview", action: "opened", intActivity: { kind: "exam", examType: "F", enteredAt: startedAt } });
  await handler("advance_subject", {}, 17373);
  readResult = () => ({ examCode: "TIMED", questionNumber: 26, totalQuestions: 50, choices: [] });
  sent.length = 0;
  const wait = await handler("answer_and_next", { examCode: "TIMED", choiceIndex: 1, save: true }, 17373);
  assert.equal(wait.mode, "pacing");
  assert.equal(wait.answerApplied, false);
  assert.ok(wait.waitMs > 1799000 && wait.waitMs <= 1800000);
  assert.ok(!sent.some(m => m.action === "apply_answer"));
  const submission = await handler("submit_current_exam", { examCode: "TIMED" }, 17373);
  assert.ok(submission.waitMs > 3599000 && submission.waitMs <= 3600000);
  assert.ok(!sent.some(m => m.action === "submit_exam"));
  const refreshed = await handler("answer_and_next", { examCode: "OLD", choiceIndex: 1 }, 17373);
  assert.equal(refreshed.mode, "resync");
  assert.equal(refreshed.examCode, "TIMED");
  assert.equal(refreshed.answerApplied, false);
  assert.ok(!sent.some(m => m.action === "apply_answer"));
  readResult = () => ({ examCode: "TIMED", questionNumber: 1, totalQuestions: 10, choices: [] });
  await assert.rejects(handler("submit_current_exam", { examCode: "TIMED" }, 17373), /exactly 50/);
  readResult = () => ({ examCode: "TIMED", questionNumber: 1, totalQuestions: 50, choices: [] });
  startedAt = Date.now() - 3600001;
  await handler("advance_subject", {}, 17373);
  assert.equal((await handler("submit_current_exam", { examCode: "TIMED" }, 17373)).action, "confirmed");
  await handler("set_exam_pacing", { durationMinutes: 120 }, 17373);
  assert.equal((await handler("submit_current_exam", { examCode: "TIMED" }, 17373)).mode, "pacing");
  // A Loop retry resets the deadline, rather than inheriting the elapsed attempt.
  startedAt = Date.now();
  await handler("advance_subject", {}, 17373);
  assert.ok((await handler("submit_current_exam", { examCode: "TIMED" }, 17373)).waitMs > 7199000);
  await handler("set_exam_pacing", { durationMinutes: 0 }, 17373);
  assert.equal((await handler("submit_current_exam", { examCode: "TIMED" }, 17373)).action, "confirmed");
  const boundExam = await handler("set_current_exam_scope", { examCode: "SINGLE" }, 17373);
  assert.equal(boundExam.scope.submissionAllowed, false);
  await assert.rejects(handler("set_exam_pacing", { durationMinutes: 60 }, 17373), /final-only/);
  await assert.rejects(handler("set_exam_loop", { enabled: true }, 17373), /final-only/);
  const countBefore = sent.length;
  for (const action of ["submit_current_exam", "advance_subject", "complete_current_lesson"]) {
    await assert.rejects(handler(action, { examCode: "SINGLE" }, 17373), /answers only/);
  }
  assert.equal(sent.length, countBefore);
  const submitScope = await handler("set_current_exam_scope", { examCode: "SINGLE", allowSubmit: true }, 17373);
  assert.equal(submitScope.scope.submissionAllowed, true);
  readResult = () => ({ examCode: "SINGLE", choices: [] });
  await handler("submit_current_exam", { examCode: "SINGLE" }, 17373);
  assert.equal(sent.at(-1).action, "submit_exam");
  await assert.rejects(handler("advance_subject", {}, 17373), /answers only/);
  pageInfo.path = "/student/virtual_school/exam.php";
  await assert.rejects(handler("set_scope", { subjectCode: "q294", mode: "chapter", chapter: 1 }, 17373), /course overview/);
}
console.log("worker regression passed: scope, pinned tab, boundary, submission stop, version, concurrency, disconnect, response metadata");

// The observed route controls: exit -> confirmation -> result/review return.
{
  const exit = element("ออกจากบทเรียน");
  const page = start({ path: "/Content", query: `${course}&lessonTitle=จำนวน`, controls: [exit] });
  assert.equal(page({ action: "advance_subject", scope }).result.action, "exit_opened");
  assert.equal(exit.clicks, 1);
  const confirm = element("ยืนยันออกบทเรียน");
  const dialog = element("ยืนยันการออกบทเรียน", { queryAll: () => [confirm] });
  const confirming = start({ path: "/Content", query: `${course}&lessonTitle=จำนวน`, dialog });
  assert.equal(confirming({ action: "advance_subject", scope }).result.action, "confirmed");
  assert.equal(confirm.clicks, 1);
  const loading = start({ path: "/Content", query: `${course}&lessonTitle=จำนวน`, bodyText: "กำลังโหลดบทเรียน", controls: [exit] });
  assert.equal(loading({ action: "advance_subject", scope }).result.action, "waiting");
  assert.equal(exit.clicks, 1);
  for (const [path, text, button] of [["/Exam", "ส่งคำตอบเรียบร้อยแล้ว", "เริ่มเรียนเนื้อหา"], ["/Exam", "ส่งคำตอบเรียบร้อยแล้ว", "ดูเฉลยคำตอบ"], ["/examanswers", "เฉลยแบบทดสอบหลังเรียน", "← กลับไปหน้าเรียน"]]) {
    const back = element(button);
    const p = start({ path, bodyText: text, controls: [back], query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
    assert.equal(p({ action: "advance_subject", scope }).result.action, "returned");
    assert.equal(back.clicks, 1);
  }
}
// Sheet overlay is distinct from the final confirmation; only its exact submit is clicked.
{
  const submit = element("ส่งคำตอบ");
  const dialog = element("กระดาษคำตอบ", { queryAll: () => [submit] });
  const page = start({ ...exam({ count: 1 }), dialog, query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน` });
  page({ action: "apply_answer", choiceIndex: 1, expectedExamCode: "EXAM:1", scope });
  assert.equal(page({ action: "submit_exam", expectedExamCode: "EXAM:1", scope }).result.action, "opened");
  assert.equal(submit.clicks, 1);
}
// Blank submission is opt-in and only applies to a corroborated pretest.
for (const type of ["P", "A"]) {
  const submit = element("ส่งคำตอบ");
  const page = start({ ...exam({ bodyText: "รหัสข้อสอบ: EXAM ทั้งหมด 2 ข้อ แบบทดสอบก่อนเรียน" }), controls: [submit], query: `${course}&chapter=1&SUB_SUBJECT_NAME=จำนวน&examtype=${type}` });
  assertError(page({ action: "submit_exam", expectedExamCode: "EXAM:1", scope }), /Not every answer/);
  const response = page({ action: "submit_exam", expectedExamCode: "EXAM:1", scope: { ...scope, allowEmptyPretest: true } });
  if (type === "P") assert.equal(response.result.action, "opened");
  else assertError(response, /Not every answer/);
}
console.log("route regression passed: lesson exit, results, review return, answer sheet, empty-pretest restriction");

{
  const page = start({ path: "/StudyCourse", articles: [] });
  assertError(page({ action: "advance_subject", scope }), /Chapter overview is loading/);
  const wrong = start({ path: "/StudyCourse", articles: [card({ number: 2, title: "Other" })] });
  assertError(wrong({ action: "advance_subject", scope }), /Target chapter cannot be identified/);
}

// INT fixtures use the selectors and attributes observed on its PHP pages.
const intOrigin = "https://int-project.com";
const intScope = { mode: "chapter", origin: intOrigin, subjectCode: "q294", level: "6", term: "2", year: "s294w2d4", subjectName: "ภาษาอังกฤษ", chapter: 1, chapterTitle: "Speaking" };
const intActivity = { kind: "exam", chapter: 1, title: "Speaking", examType: "A" };
const intExam = ({ total = 2, number = 1, pretest = false, activity = intActivity } = {}) => {
  const selectors = {}, lists = { ".modal.in": [] };
  const r = [1, 2, 3, 4, 5].map((i) => element("", { id: `rdoAns${i}`, checked: false, click() { this.clicks++; r.forEach((x) => { x.checked = false; }); this.checked = true; } }));
  const heading = element(`คำถามข้อที่ ${number}.`);
  const root = element("รหัสข้อสอบ : INT-Q1 | account", { children: [heading, element("Question")], queryAll: () => r });
  const save = element("บันทึกคำตอบ", { click() { this.clicks++; this.disabled = true; } });
  Object.assign(selectors, { "#main_quizs": root, "#save_exam": save, '#main_quizs input[name="rdoAns"]': r[0] });
  r.forEach((item, i) => { selectors[`#rdoAns${i + 1}`] = item; selectors[`#A${i + 1}`] = element(`Choice ${i + 1}`); });
  const bodyText = activity.examType === "F" ? `แบบทดสอบปลายภาค วิชา ภาษาอังกฤษ ภาคเรียนที่2 จำนวนข้อสอบ${total}ข้อ` : `แบบทดสอบ${pretest ? "ก่อน" : "หลัง"}เรียน วิชา ภาษาอังกฤษ หน่วยการเรียนรู้ที่ 1 Speaking ภาคเรียนที่2 จำนวนข้อสอบ${total}ข้อ`;
  const page = start({ origin: intOrigin, path: "/student/virtual_school/exam.php", query: "", bodyText, selectors, lists });
  const scope = { ...intScope, ...(activity.examType === "F" ? { mode: "final", chapter: undefined, chapterTitle: undefined } : {}), intActivity: activity };
  return { page, scope, selectors, lists, r, root, heading, save };
};
{
  const { page, scope, r, root, selectors, save } = intExam();
  assert.equal(page({ action: "read_question" }).result.totalQuestions, 2);
  assertError(page({ action: "apply_answer", expectedExamCode: "INT-Q1", choiceIndex: 1, save: true, scope: intScope }), /scoped overview/);
  assertError(page({ action: "apply_answer", expectedExamCode: "WRONG", choiceIndex: 1, save: true, scope }), /stale exam/);
  assertError(page({ action: "apply_answer", expectedExamCode: "INT-Q1", choiceIndex: 1, save: false, scope }), /requires save=true/);
  assert.equal(r[0].checked, false);
  const applied = page({ action: "apply_answer", expectedExamCode: "INT-Q1", choiceIndex: 1, save: true, scope });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.result.autoAdvance, true);
  assert.equal(applied.result.lastQuestion, false);
  assert.equal(applied.result.saved, null);
  assert.equal(save.clicks, 1);
  assert.equal(page({ action: "read_question" }).result.saving, true);
  assertError(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }), /pending answer save/);
  // The site replaces #save_exam after the save response, including when it wraps back to Q1.
  selectors["#save_exam"] = element("บันทึกคำตอบ");
  root.innerText = "รหัสข้อสอบ : INT-Q2 | account";
  assert.equal(page({ action: "read_question" }).result.saving, false);
}
{
  const { page, scope } = intExam({ total: 10, number: 10 });
  assert.equal(page({ action: "apply_answer", expectedExamCode: "INT-Q1", choiceIndex: 3, save: true, scope }).result.lastQuestion, true);
  const wrong = intExam({ activity: { ...intActivity, chapter: 2, title: "Vocabulary" } });
  assertError(wrong.page({ action: "advance_subject", scope: wrong.scope }), /scoped overview/);
}
for (const pretest of [false, true]) {
  const fixture = intExam({ pretest, activity: { ...intActivity, examType: pretest ? "P" : "A" } });
  const { page, lists, selectors } = fixture;
  const scope = { ...fixture.scope, allowEmptyPretest: true };
  const send = selectors["#anssend"] = element("ส่งคำตอบทั้งหมด");
  const sheet = selectors["#ansedit"] = element("กระดาษคำตอบ");
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.action, pretest ? "opened" : "opened_sheet");
  assert.equal(send.clicks, pretest ? 1 : 0);
  const confirm = element("ยืนยัน");
  lists[".modal.in"] = [element("ท่านยังไม่ได้ทำข้อต่อไปนี้ ? ข้อที่ 1 ท่านต้องการส่งคำตอบทั้งหมดใช่หรือไม่ ?", { query: (s) => s === "#btn_confirm" ? confirm : null })];
  assert.equal(page({ action: "advance_subject", scope }).result.action, "confirmation_required");
  assert.equal(confirm.clicks, 0);
  const result = page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope });
  if (pretest) assert.equal(result.result.action, "confirmed");
  else assertError(result, /Not every saved answer/);
  assert.equal(confirm.clicks, pretest ? 1 : 0);
  assert.equal(sheet.clicks, pretest ? 0 : 1);
}
{
  const { page, scope, lists, selectors } = intExam();
  const confirm = element("ยืนยัน");
  lists[".modal.in"] = [element("Unexpected confirmation", { query: () => confirm })];
  assertError(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }), /Unknown submission dialog/);
  assert.equal(confirm.clicks, 0);
  const close = element("", { click() { lists[".modal.in"] = []; } });
  const rows = [1, 2].map((n) => element(`ข้อที่ ${n}. A`, { attributes: { quesid: String(n) }, query: () => element("A") }));
  lists[".modal.in"] = [element("กระดาษคำตอบ", { queryAll: () => rows, query: () => close })];
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.verifiedAnswers, 2);
  const submit = selectors["#anssend"] = element("ส่งคำตอบทั้งหมด");
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.action, "opened");
  assert.equal(submit.clicks, 1);
  lists[".modal.in"] = [element("ท่านต้องการส่งคำตอบทั้งหมดใช่หรือไม่ ?", { query: () => confirm })];
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.action, "confirmed");
  assert.equal(confirm.clicks, 1);
  // A stale or incomplete answer sheet cannot establish proof, even when all rows exist.
  rows[1] = element("ข้อที่ 2. -", { attributes: { quesid: "2" }, query: () => element("-") });
  lists[".modal.in"] = [element("กระดาษคำตอบ", { queryAll: () => rows, query: () => close })];
  assertError(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }), /Not every saved answer/);
}
// INT uses letters on some exams and numeric choices on others.
for (const badge of ["A", "E", "1", "2", "3", "4", "5", "ก", "ข", "ค", "ง", "จ", "", "-", "0", "6", "10", "F", "ฉ", "ฃ"]) {
  const { page, scope, lists, selectors } = intExam({ total: 1 });
  const close = element("", { click() { lists[".modal.in"] = []; } });
  const row = element(`ข้อที่ 1.${badge}`, { attributes: { quesid: "1" }, query: () => element(badge) });
  lists[".modal.in"] = [element("กระดาษคำตอบ", { queryAll: () => [row], query: () => close })];
  const result = page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope });
  if (["A", "E", "1", "2", "3", "4", "5", "ก", "ข", "ค", "ง", "จ"].includes(badge)) {
    assert.equal(result.ok, true, `${badge}: ${result.error}`);
    assert.equal(result.result.action, "verified_sheet");
    const submit = selectors["#anssend"] = element("ส่งคำตอบทั้งหมด");
    assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.action, "opened");
    assert.equal(submit.clicks, 1);
  } else {
    assertError(result, /Not every saved answer/);
    assert.equal(lists[".modal.in"].length, 1);
  }
}
const intCard = ({ number = 1, title = "Speaking", complete = false, lesson = false, hidden = false } = {}) => {
  const green = element("", { attributes: { style: "color: #32CD32;" } });
  const examAttrs = { href: "check_error.php", subj: "q294", year: "s294w2d4", idlearn: String(number), examtype: "P" };
  const pre = element("แบบทดสอบก่อนเรียน", { attributes: examAttrs, query: () => !complete && !lesson ? element() : null, queryAll: () => complete || lesson ? [green] : [] });
  const topic = element("Speaking", { hidden, classes: ["learn"], attributes: { href: "check_error.php", contents: "NjA1NTAx", term: "Mg==", level: "Ng==", ranglevel: "NA==", linelearn: "MA==" }, query: () => !complete && lesson ? element() : null, queryAll: () => complete ? [green] : [] });
  const post = element("แบบทดสอบหลังเรียน", { queryAll: () => complete ? [green] : [] });
  const expand = element("เข้าสู่เนื้อหาบทเรียน");
  const header = element(`หน่วยการเรียนรู้ที่ ${number} ${title}`);
  const node = element("", { query: (s) => s === ":scope > .panel-heading" ? header : s === ".ziehharmonika h3" ? expand : null, queryAll: () => [pre, topic, post] });
  return { node, pre, topic, expand };
};
const intOverviewPage = (cards, year = "s294w2d4") => start({ origin: intOrigin, path: "/student/virtual_school/index.php", query: "",
  selectors: { ".retroshadow": element("ระดับชั้น มัธยมศึกษาปีที่ 6 ภาคเรียนที่ 2 วิชาภาษาอังกฤษ") },
  lists: { ".panel-warning": cards.map((c) => c.node), 'a.exam[examtype="P"][href]': [element("", { attributes: { subj: "q294", year } })] } });
{
  const first = intCard(), second = intCard({ number: 2, title: "Vocabulary" });
  const page = intOverviewPage([first, second]);
  assert.equal(page({ action: "inspect_page" }).result.course.subjectCode, "q294");
  const opened = page({ action: "advance_subject", scope: intScope }).result;
  assert.equal(opened.intActivity.chapter, 1);
  assert.equal(opened.intActivity.examType, "P");
  assert.equal(first.pre.clicks, 1);
  assert.equal(second.pre.clicks, 0);
  const completed = intOverviewPage([intCard({ complete: true }), second]);
  assert.equal(completed({ action: "advance_subject", scope: intScope }).result.mode, "chapter_complete");
  assert.equal(second.pre.clicks, 0);
  assertError(intOverviewPage([first], "other-year")({ action: "advance_subject", scope: intScope }), /Scope mismatch/);
  assertError(intOverviewPage([])({ action: "advance_subject", scope: intScope }), /Chapter overview is loading/);
  const collapsed = intCard({ lesson: true, hidden: true });
  assert.equal(intOverviewPage([collapsed])({ action: "advance_subject", scope: intScope }).result.action, "expanded");
  assert.equal(collapsed.topic.clicks, 0);
  assert.equal(collapsed.expand.clicks, 1);
  const expanded = intCard({ lesson: true });
  const activity = intOverviewPage([expanded])({ action: "advance_subject", scope: intScope }).result.intActivity;
  assert.equal(activity.params.content, "NjA1NTAx");
  const save = element("บันทึกเวลาเรียนและออกจากบทเรียน");
  const selectors = { "button.save-learn": save }, lists = { ".modal.in": [] };
  const content = (query) => start({ origin: intOrigin, path: "/student/virtual_school/content/", query, selectors, lists });
  const query = "?content=NjA1NTAx&term=Mg%3D%3D&level=Ng%3D%3D&rang=NA%3D%3D&linelearn=MA%3D%3D";
  const bound = { ...intScope, intActivity: activity };
  assert.equal(content(query)({ action: "advance_subject", scope: bound }).result.action, "exit_opened");
  assertError(content(query.replace("NjA1NTAx", "other"))({ action: "advance_subject", scope: bound }), /Lesson is outside/);
  const confirm = element("บันทึกเวลาและออกจากบทเรียน");
  lists[".modal.in"] = [element("ต้องการออกจากบทเรียนนี้ ?", { query: () => confirm })];
  assert.equal(content(query)({ action: "advance_subject", scope: bound }).result.action, "confirmed");
  assert.equal(confirm.clicks, 1);
  const back = element("กลับสู่หน้าแผนการเรียน");
  const result = start({ origin: intOrigin, path: "/student/virtual_school/exam_result.php", query: "", bodyText: "ผลการสอบ แบบทดสอบหลังเรียน วิชา ภาษาอังกฤษ หน่วยการเรียนรู้ Speaking คุณทำแบบทดสอบหลังเรียน ได้ 10 ข้อ", selectors: { ".backplan": back } });
  assert.equal(result({ action: "advance_subject", scope: { ...intScope, intActivity } }).result.action, "returned");
  assert.equal(back.clicks, 1);
}
console.log("INT regression passed: scoped PHP routes, saved-answer sheet, pretest, auto-save acknowledgement, last question, collapsed lessons, chapter boundary");

// Final exams reuse answer verification, but have no chapter in their headings.
{
  const { page, scope, lists, selectors } = intExam({ total: 50, number: 50, activity: { kind: "exam", examType: "F" } });
  assert.equal(page({ action: "advance_subject", scope }).result.needsAnswers, true);
  assertError(page({ action: "advance_subject", scope: { ...scope, mode: "chapter" } }), /scoped overview/);
  const send = selectors["#anssend"] = element("ส่งคำตอบทั้งหมด");
  selectors["#ansedit"] = element("กระดาษคำตอบ");
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope: { ...scope, allowEmptyPretest: true } }).result.action, "opened_sheet");
  const close = element("", { click() { lists[".modal.in"] = []; } });
  const rows = Array.from({ length: 50 }, (_, i) => element("", { attributes: { quesid: String(i + 1) }, query: () => element("2") }));
  const sheet = element("กระดาษคำตอบ", { queryAll: () => rows, query: () => close });
  lists[".modal.in"] = [sheet];
  rows.pop();
  assertError(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }), /Not every saved answer/);
  rows.push(element("", { attributes: { quesid: "50" }, query: () => element("4") }));
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.verifiedAnswers, 50);
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.action, "opened");
  const confirm = element("ยืนยัน");
  lists[".modal.in"] = [element("ท่านต้องการส่งคำตอบทั้งหมดใช่หรือไม่ ?", { query: () => confirm })];
  assert.equal(page({ action: "submit_exam", expectedExamCode: "INT-Q1", scope }).result.action, "confirmed");
  assert.equal(confirm.clicks, 1);
}
{
  const chapter = intCard();
  const final = element("แบบทดสอบปลายภาค", { attributes: { subj: "q294", year: "s294w2d4", href: "check_error.php" }, query: () => element("yellow") });
  const make = (finals = [final]) => start({ origin: intOrigin, path: "/student/virtual_school/index.php", query: "",
    selectors: { ".retroshadow": element("ระดับชั้น มัธยมศึกษาปีที่ 6 ภาคเรียนที่ 2 วิชาภาษาอังกฤษ") },
    lists: { ".panel-warning": [chapter.node], 'a.exam[examtype="P"][href]': [chapter.pre], 'a.exam[examtype="F"]': finals } });
  const finalScope = { ...intScope, mode: "final" };
  assert.equal(make()({ action: "advance_subject", scope: finalScope }).result.intActivity.examType, "F");
  assert.equal(chapter.pre.clicks, 0);
  assert.equal(final.clicks, 1);
  assertError(make([final, final])({ action: "advance_subject", scope: finalScope }), /not uniquely/);
  const wrong = element("", { attributes: { subj: "other" } });
  assertError(make([wrong])({ action: "advance_subject", scope: finalScope }), /does not match scope/);
  const bound = { ...finalScope, intActivity: { kind: "exam", examType: "F" } };
  for (const passed of [false, true]) {
    const back = element("กลับสู่หน้าแผนการเรียน");
    const result = start({ origin: intOrigin, path: "/student/virtual_school/exam_result.php", query: "", bodyText: `ผลการสอบ แบบทดสอบปลายภาค วิชา ภาษาอังกฤษ คุณทำแบบทดสอบปลายภาค ได้ ${passed ? 50 : 3} ข้อ จากทั้งหมด 50 ข้อ ผลการทดสอบ คือ ${passed ? "ผ่าน" : "ไม่ผ่าน"}`, selectors: { ".backplan": back } });
    const returned = result({ action: "advance_subject", scope: bound }).result;
    assert.equal(returned.intActivity.finalResult.passed, passed);
    assert.equal(back.clicks, 1);
    const completed = make()({ action: "advance_subject", scope: { ...bound, intActivity: returned.intActivity } }).result;
    assert.equal(completed.mode, "complete");
    assert.equal(completed.finalResult.passed, passed);
    assert.equal(final.clicks, 1); // Failed attempts must not start a retry loop.
  }
}
console.log("INT final regression passed: final-only entry, 50 saved answers, no empty-final bypass, result return, stop after one attempt");

// Virtual final-only scope skips unfinished chapters and rejects sibling activities.
{
  const finalScope = { ...scope, mode: "final" };
  const chapter = card({ number: 1, title: "จำนวน" });
  const final = element("ทำแบบทดสอบปลายภาค");
  const overview = start({ path: "/StudyCourse", articles: [chapter], controls: [final] });
  assert.equal(overview({ action: "advance_subject", scope: finalScope }).result.action, "opened");
  assert.equal(final.clicks, 1);
  assert.equal(chapter.card.pre.clicks, 0);
  const blocked = start({ path: "/StudyCourse", controls: [element("ทำแบบทดสอบปลายภาค", { disabled: true })] });
  assert.equal(blocked({ action: "advance_subject", scope: finalScope }).result.mode, "scope_boundary");
  for (const path of ["/Content", "/Exam", "/examanswers"]) {
    assertError(start({ path })({ action: "advance_subject", scope: finalScope }), /requested final/);
  }
  const state = exam({ count: 50 });
  const controls = [element("ส่งคำตอบ")];
  const page = start({ ...state, controls, query: `${course}&examtype=F` });
  assertError(page({ action: "advance_subject", scope }), /requested chapter/);
  assert.equal(page({ action: "advance_subject", scope: finalScope }).result.needsAnswers, true);
  assertError(page({ action: "submit_exam", scope: { ...finalScope, allowEmptyPretest: true }, expectedExamCode: "EXAM:1" }), /Not every answer/);
  for (let n = 1; n <= 50; n++) {
    state.question.heading.innerText = `ข้อคำถามที่ ${n}`;
    assert.equal(page({ action: "apply_answer", scope: finalScope, expectedExamCode: `EXAM:${n}`, choiceIndex: 1 }).ok, true);
  }
  assert.equal(page({ action: "submit_exam", scope: finalScope, expectedExamCode: "EXAM:50" }).result.action, "opened");
  assert.equal(controls[0].clicks, 1);
}

{
  const retry = element("ทำแบบทดสอบปลายภาค", { click: () => assert.fail("retried final") });
  const result = start({ path: "/Exam", query: `${course}&examtype=F`, bodyText: "ส่งคำตอบเรียบร้อยแล้ว", controls: [retry] });
  for (const mode of ["final", "subject"]) {
    const completed = result({ action: "advance_subject", scope: { ...scope, mode } }).result;
    assert.equal(completed.mode, "complete");
    assert.equal(completed.submitted, true);
  }
}
console.log("Virtual final regression passed: scope, 50-answer ledger, submission completion, no retry");

// Direct exam scope works without course IDs and never permits submission/navigation.
for (const int of [false, true]) {
  const fixture = int ? intExam() : { page: start({ ...exam(), query: "" }) };
  const code = int ? "INT-Q1" : "EXAM:1";
  assertError(fixture.page({ action: "bind_current_exam", expectedExamCode: "wrong", examBinding: "binding" }), /Stale/);
  const bound = fixture.page({ action: "bind_current_exam", expectedExamCode: code, examBinding: "binding" });
  assert.equal(bound.ok, true, bound.error);
  const scope = bound.result;
  assert.equal(scope.submissionAllowed, false);
  for (const action of ["submit_exam", "advance_subject"]) assertError(fixture.page({ action, scope, expectedExamCode: code }), /answers only/);
  assertError(fixture.page({ action: "read_question", scope: { ...scope, examBinding: "old" } }), /expired/);
  assert.equal(fixture.page({ action: "apply_answer", scope, expectedExamCode: code, choiceIndex: 1, save: int }).ok, true);
  const fresh = int ? intExam().page : start({ ...exam(), query: "" });
  assertError(fresh({ action: "read_question", scope }), /expired/);
}
assertError(start({ path: "/StudyCourse" })({ action: "bind_current_exam", expectedExamCode: "EXAM:1", examBinding: "binding" }), /Open an exam/);
console.log("Direct exam regression passed: no course ID, stale binding, page reload, answers only, no submission");

// Submission is opt-in, page-bound, and still requires complete answers.
for (const int of [false, true]) {
  const submit = element("ส่งคำตอบ");
  const fixture = int ? intExam() : { page: start({ ...exam({ count: 1 }), query: "", controls: [submit] }) };
  const code = int ? "INT-Q1" : "EXAM:1";
  const bind = (allowSubmit) => fixture.page({ action: "bind_current_exam", expectedExamCode: code, examBinding: "allowed", allowSubmit }).result;
  const denied = bind(false);
  assertError(fixture.page({ action: "submit_exam", expectedExamCode: code, scope: { ...denied, submissionAllowed: true } }), /answers only/);
  const scope = bind(true);
  assert.equal(scope.submissionAllowed, true);
  assertError(fixture.page({ action: "advance_subject", scope }), /answers only/);
  if (int) {
    fixture.selectors["#ansedit"] = submit;
    assert.equal(fixture.page({ action: "submit_exam", expectedExamCode: code, scope }).result.action, "opened_sheet");
  } else {
    assertError(fixture.page({ action: "submit_exam", expectedExamCode: code, scope }), /Not every answer/);
    fixture.page({ action: "apply_answer", expectedExamCode: code, choiceIndex: 1, scope });
    assert.equal(fixture.page({ action: "submit_exam", expectedExamCode: code, scope }).result.action, "opened");
  }
  assert.equal(submit.clicks, 1);
}
console.log("Current exam submission opt-in regression passed");

// Result reads survive exam navigation, but exam questions cannot be read as results.
{
  assertError(start({ ...exam() })({ action: "read_exam_result" }), /submitted result/);
  const review = element("ดูเฉลยคำตอบ");
  const page = start({ bodyText: "ส่งคำตอบเรียบร้อยแล้ว คะแนน 8/10", controls: [review] });
  const result = page({ action: "read_exam_result" }).result;
  assert.equal(result.correctness, "unverified");
  assert.equal(result.reviewAvailable, true);
  assertError(page({ action: "open_answer_review", expectedResultToken: "stale" }), /Result changed/);
  assert.equal(review.clicks, 0);
  assert.equal(page({ action: "open_answer_review", expectedResultToken: result.resultToken }).result.action, "opened_review");
  assert.equal(review.clicks, 1);
  const int = start({ origin: intOrigin, path: "/student/virtual_school/exam_result.php", bodyText: "ผลการสอบ ได้ 3 ข้อ จากทั้งหมด 50 ข้อ" });
  const intResult = int({ action: "read_exam_result" }).result;
  assert.equal(intResult.reviewAvailable, false);
  assertError(int({ action: "open_answer_review", expectedResultToken: intResult.resultToken }), /not available/);
}
console.log("Result evidence regression passed: unverified totals, stale token, unique review control");

// Exact INT review labels and disabled answer controls are required for verification.
{
  const choices = [radio("A"), radio("B")];
  choices.forEach((r, i) => { r.id = "rdoAns" + (i + 1); r.disabled = true; });
  choices[0].checked = true;
  const question = element("Question", { query: () => ({ src: "https://www.virtualschool.club/admin/question_pic/q.jpg" }) });
  const root = element("คำถามข้อที่ 1. รหัสข้อสอบ : REVIEW คำตอบข้อที่ถูก 2.", {
    query: (s) => s === ".col-md-10.col-md-offset-1" ? question : null, queryAll: () => choices,
  });
  const selectors = { "#frm_exam": root, "#A1": element("A"), "#A2": element("B") };
  const page = start({ origin: intOrigin, path: "/student/virtual_school/exam_answer.php", bodyText: "จำนวนข้อสอบ 1 ข้อ", selectors });
  const result = page({ action: "read_exam_result" }).result;
  assert.equal(result.correctChoiceIndex, 2);
  assert.equal(result.selectedChoiceIndex, 1);
  assert.equal(result.correctness, "incorrect");
  assert.equal(result.choices[1].text, "B");
  assert.equal(page({ action: "open_answer_review", expectedResultToken: result.resultToken, step: "next" }).result.done, true);
  for (const label of ["2", "B", "ข"]) {
    root.innerText = "คำถามข้อที่ 1. รหัสข้อสอบ : REVIEW คำตอบข้อที่ถูก " + label + ".";
    assert.equal(page({ action: "read_exam_result" }).result.correctChoiceIndex, 2);
  }
  for (const label of ["", "Z", "ฉ", "22", "ขข"]) {
    root.innerText = "คำถามข้อที่ 1. รหัสข้อสอบ : REVIEW คำตอบข้อที่ถูก " + label + ".";
    assertError(page({ action: "read_exam_result" }), /not ready/);
  }
  root.innerText = "คำถามข้อที่ 1. รหัสข้อสอบ : REVIEW คำตอบข้อที่ถูก ข.";
  choices[0].checked = false; choices[1].checked = true;
  assert.equal(page({ action: "read_exam_result" }).result.correctness, "correct");
  choices[1].disabled = false;
  assertError(page({ action: "read_exam_result" }), /not ready/);
}

// Verified history survives sessions, follows shuffled choices, and refuses conflicting evidence.
{
  const directory = mkdtempSync(join(tmpdir(), "int-review-check-"));
  try {
    const history = createHistory(directory, intScope);
    const question = { questionText: "Question", questionImage: null, choices: [{index: 1, text: "A"}, {index: 2, text: "B"}] };
    history.append({ type: "answer_returned", correctness: "unverified", selected: 1 });
    assert.equal(history.lookup(question), null);
    history.rememberReview({ ...question, correctChoiceIndex: 2 });
    assert.equal(history.lookup(question), null);
    history.rememberReview({ ...question, correctChoiceIndex: 2, verificationSource: "INT explicit correct-answer label", evidence: "คำตอบข้อที่ถูก 2." });
    const next = createHistory(directory, intScope);
    assert.ok(history.file.includes("ภาษาอังกฤษ-"));
    const saved = JSON.parse(readFileSync(history.file, "utf8").trim().split("\n").at(-1));
    assert.equal(saved.subject.subjectName, "ภาษาอังกฤษ");
    assert.equal(createHistory(directory, { ...intScope, subjectCode: "MATH", subjectName: "คณิตศาสตร์" }).lookup(question), null);
    assert.equal(createHistory(directory, { ...intScope, term: "1" }).lookup(question), null);
    assert.equal(createHistory(directory).lookup(question), null);
    assert.equal(next.lookup(question).choiceIndex, 2);
    assert.equal(next.lookup({ ...question, questionText: "  Question  ", choices: [{index: 1, text: "B"}, {index: 2, text: "A"}] }).choiceIndex, 1);
    assert.equal(next.lookup({ ...question, questionText: "Different" }), null);
    history.rememberReview({ ...question, correctChoiceIndex: 1, verificationSource: "INT explicit correct-answer label" });
    assert.equal(next.lookup(question), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log("Verified history regression passed: evidence only, shuffled choices, cross-session lookup, conflicts");

// A 50-question perfect-score loop reviews every question and does not stop at merely passing.
{
  const chapter = intCard();
  const final = element("แบบทดสอบปลายภาค", { attributes: { subj: "q294", year: "s294w2d4", href: "check_error.php" } });
  const overview = start({ origin: intOrigin, path: "/student/virtual_school/index.php", query: "",
    selectors: { ".retroshadow": element("ระดับชั้น มัธยมศึกษาปีที่ 6 ภาคเรียนที่ 2 วิชาภาษาอังกฤษ") },
    lists: { ".panel-warning": [chapter.node], 'a.exam[examtype="P"][href]': [chapter.pre], 'a.exam[examtype="F"]': [final] } });
  let loop = { ...intScope, mode: "final", retryUntilPerfect: true, intActivity: { kind: "exam", examType: "F", attempt: 1, finalResult: { correct: 47, total: 50, passed: true } } };
  assert.equal(overview({ action: "advance_subject", scope: loop }).result.mode, "review_required");
  assert.equal(final.clicks, 0);
  loop.intActivity.reviewedQuestions = Array.from({ length: 50 }, (_, i) => i + 1);
  const retry = overview({ action: "advance_subject", scope: loop }).result;
  assert.equal(retry.action, "opened");
  assert.equal(retry.intActivity.attempt, 2);
  assert.equal(retry.intActivity.reviewedQuestions, undefined);
  assert.equal(retry.intActivity.finalResult, undefined);
  assert.equal(final.clicks, 1);
  loop.intActivity.finalResult = { correct: 49, total: 50, passed: true };
  assert.equal(overview({ action: "advance_subject", scope: loop }).result.action, "opened");
  loop.intActivity.finalResult = { correct: 50, total: 50, passed: true };
  assert.equal(overview({ action: "advance_subject", scope: loop }).result.mode, "complete");
  assert.equal(final.clicks, 2);
  loop.intActivity.finalResult = { correct: 9, total: 10, passed: true };
  assertError(overview({ action: "advance_subject", scope: loop }), /exactly 50/);
  const small = intExam({ total: 10, activity: { kind: "exam", examType: "F" } });
  assertError(small.page({ action: "apply_answer", scope: { ...small.scope, retryUntilPerfect: true }, choiceIndex: 1, expectedExamCode: "INT-Q1", save: true }), /exactly 50/);
  assert.equal(small.r[0].checked, false);
  const back = element("กลับสู่หน้าแผนการเรียน");
  const result = start({ origin: intOrigin, path: "/student/virtual_school/exam_result.php", query: "", bodyText: "แบบทดสอบปลายภาค วิชา ภาษาอังกฤษ คุณทำแบบทดสอบปลายภาค ได้ 47 ข้อ จากทั้งหมด 50 ข้อ ผลการทดสอบ คือ ผ่าน", selectors: { ".backplan": back } });
  assert.equal(result({ action: "advance_subject", scope: loop }).result.mode, "review_required");
  assert.equal(back.clicks, 0);
  assert.equal(result({ action: "advance_subject", scope: { ...loop, retryUntilPerfect: false } }).result.action, "returned");
}
console.log("50-question loop passed: 47/50 -> review -> retry, 49/50 retry, 50/50 stop, 10-question refusal");

// Subject cards use printed progress: INT renders its 0% bar at width:100%.
{
  const makeLink = (code, progress, term = "s2") => element("", {
    attributes: { subj: code, level: "w2", term, ranglevel: "range" },
    parentElement: element("", { query: selector => selector === ".progress-bar" ? element(progress, { attributes: { style: "width:100%" } }) : null }),
  });
  const links = [makeLink("MATH", "0%"), makeLink("ENG", "100%"), makeLink("SCI", "60.00%")];
  const lists = { 'a.learn[href="check_error.php"][subj][term][level][ranglevel]': links };
  const page = start({ origin: intOrigin, path: "/student/virtual_school/", query: "", lists });
  const listing = page({ action: "read_subjects" });
  assert.equal(listing.ok, true, listing.error);
  assert.equal(listing.result.subjects[0].progress, 0);
  assert.equal(listing.result.subjects[0].finished, false);
  assert.equal(listing.result.subjects[1].finished, true);
  const listToken = listing.result.listToken;
  assertError(page({ action: "open_subject", listToken: "stale", subjectCode: "MATH" }), /changed/);
  assertError(page({ action: "open_subject", listToken, subjectCode: "ENG" }), /already finished/);
  assertError(page({ action: "open_subject", listToken, subjectCode: "OTHER" }), /missing/);
  assert.equal(page({ action: "open_subject", listToken, subjectCode: "MATH" }).result.action, "opened_subject");
  assert.equal(links[0].clicks, 1);
  links[0] = makeLink("MATH", "unknown");
  assertError(page({ action: "open_subject", listToken, subjectCode: "MATH" }), /unknown/);
  links[0] = makeLink("MATH", "0%", "s1");
  assertError(page({ action: "read_subjects" }), /ambiguous/);
  assertError(start({ ...exam() })({ action: "read_subjects" }), /subject selection/);
  assertError(page({ action: "return_to_subjects" }), /explicit scope/);
}
{
  const chapter = intCard({ complete: true });
  const back = element("เลือกวิชา", { attributes: { level: "w2" } });
  const final = element("แบบทดสอบปลายภาค", { attributes: { subj: "q294", year: "s294w2d4" },
    queryAll: () => [element("", { attributes: { style: "color:#32cd32" } })] });
  const page = start({ origin: intOrigin, path: "/student/virtual_school/index.php", query: "",
    selectors: { ".retroshadow": element("ระดับชั้น มัธยมศึกษาปีที่ 6 ภาคเรียนที่ 2 วิชาภาษาอังกฤษ") },
    lists: { ".panel-warning": [chapter.node], 'a.exam[examtype="P"][href]': [chapter.pre], "a.backsubject": [back], 'a.exam[examtype="F"]': [final] } });
  assertError(page({ action: "return_to_subjects", scope: intScope }), /scoped INT course overview/);
  assertError(page({ action: "return_to_subjects", scope: { ...intScope, mode: "subject", term: "1" } }), /mismatch/);
  assert.equal(page({ action: "return_to_subjects", scope: { ...intScope, mode: "subject" } }).result.action, "returned_to_subjects");
  assert.equal(back.clicks, 1);
  assert.equal(page({ action: "advance_subject", scope: { ...intScope, mode: "subject" } }).result.alreadyFinished, true);
  assert.equal(final.clicks, 0);
}
console.log("Subject list checks passed: printed 0%, finished skip, stale IDs/term, unknown progress, scoped return");

// A full submitted sheet confirms greens from this attempt; only reds need opening.
{
  let summarize;
  const worker = readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const pure = worker.slice(worker.indexOf("const selectiveReview ="), worker.indexOf("const mutations ="));
  runInNewContext(pure + "\nexpose(selectiveReview);", { expose: fn => { summarize = fn; } });
  const answers = new Map(Array.from({ length: 50 }, (_, i) => [i + 1, {
    questionNumber: i + 1, examCode: "Q" + (i + 1), questionText: "Question " + (i + 1), selectedChoiceIndex: 2,
    choices: [{ index: 1, text: "A" }, { index: 2, text: "B" }],
  }]));
  const sheet = Array.from({ length: 50 }, (_, i) => ({ questionNumber: i + 1, selectedChoiceIndex: 2, correctness: i < 40 ? "correct" : "incorrect" }));
  const session = { submitted: true, attemptAnswers: answers, scope: { intActivity: { finalResult: { correct: 40 } } } };
  const current = { ...answers.get(1), totalQuestions: 50, correctChoiceIndex: 2, sheet };
  let result = summarize(session, current);
  assert.equal(result.verifiedReviews.length, 40);
  assert.equal(result.rejectedReviews.length, 10);
  assert.equal(JSON.stringify(result.reviewPlan.needsReview), JSON.stringify(Array.from({ length: 10 }, (_, i) => i + 41)));
  for (let number = 41; number <= 50; number++) result = summarize(session, { ...answers.get(number), totalQuestions: 50, sheet: [] });
  assert.equal(result.reviewPlan.done, true);
  assert.equal(result.reviewPlan.verifiedCount, 50);
  const resumed = { scope: { intActivity: {} } };
  assert.equal(summarize(resumed, current).verifiedReviews.length, 0, "no cross-attempt join after reconnect");
  assert.equal(summarize(resumed, current).reviewPlan.needsReview.length, 49);
  assert.throws(() => summarize(session, { ...current, sheet: sheet.slice(1) }), /incomplete/);
  assert.throws(() => summarize(session, { ...current, sheet: sheet.map(r => ({ ...r, correctness: "correct" })) }), /submitted score/);
  const mismatch = { submitted: true, attemptAnswers: answers, scope: { intActivity: {} } };
  assert.equal(summarize(mismatch, { ...current, examCode: "OTHER" }).verifiedReviews.length, 0);
}

// Direct review navigation jumps to a red row and parses Thai sheet choices.
{
  const radios = [radio("A"), radio("B")];
  radios.forEach((r, i) => { r.id = "rdoAns" + (i + 1); r.disabled = true; });
  const root = element("คำถามข้อที่ 1. รหัสข้อสอบ : REVIEW คำตอบข้อที่ถูก ข.", {
    query: () => element("Question"), queryAll: () => radios,
  });
  const row = element("41). ข", { classes: ["danger"], attributes: { data_nox: "41" } });
  const dialog = element("กระดาษคำตอบ", { queryAll: () => [row] });
  const page = start({ origin: intOrigin, path: "/student/virtual_school/exam_answer.php", bodyText: "จำนวนข้อสอบ 50 ข้อ",
    selectors: { "#frm_exam": root, "#A1": element("A"), "#A2": element("B") }, lists: { ".modal.in": [dialog] } });
  const result = page({ action: "read_exam_result" }).result;
  assert.equal(result.sheet[0].selectedChoiceIndex, 2);
  assert.equal(result.sheet[0].correctness, "incorrect");
  assert.equal(page({ action: "open_answer_review", expectedResultToken: result.resultToken, step: "question", questionNumber: 41 }).ok, true);
  assert.equal(row.clicks, 1);
  assertError(page({ action: "open_answer_review", expectedResultToken: result.resultToken, step: "question", questionNumber: 51 }), /Invalid/);
}

// New wrong-answer evidence removes that saved choice; newly reviewed answers accumulate.
{
  const directory = mkdtempSync(join(tmpdir(), "int-selective-history-"));
  try {
    const h = createHistory(directory, intScope);
    const q = { questionText: "Repeated", questionImage: null, choices: [{ index: 1, text: "A" }, { index: 2, text: "B" }] };
    h.rememberReview({ ...q, correctChoiceIndex: 1, verificationSource: "INT explicit correct-answer label" });
    h.rejectAnswer({ ...q, selectedChoiceIndex: 1, correctness: "incorrect", verificationSource: "INT submitted answer-sheet marker" });
    assert.equal(h.lookup(q), null);
    h.rememberReview({ ...q, selectedChoiceIndex: 2, correctChoiceIndex: 2, correctness: "correct", verificationSource: "INT submitted answer-sheet marker" });
    assert.equal(createHistory(directory, intScope).lookup(q).choiceIndex, 2);
    h.rememberReview({ ...q, questionText: "New", selectedChoiceIndex: 1, correctChoiceIndex: 1, correctness: "correct", verificationSource: "INT submitted answer-sheet marker" });
    assert.equal(h.lookup({ ...q, questionText: "New" }).choiceIndex, 1);
    assert.equal(h.lookup(q).choiceIndex, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log("Selective review passed: 40 greens + 10 red visits, direct jump, Thai sheet labels, mismatch refusal, accumulating corrections");

// Completed green finals remain clickable for an explicitly requested Normal retake.
{
  const chapter = intCard({ complete: true });
  const green = element('', { attributes: { style: 'color:#32CD32' } });
  const final = element('แบบทดสอบปลายภาค', { attributes: { href:'check_error.php', subj:'q294', year:'s294w2d4', level:'w2', term:'r2', ranglevel:'u2' }, queryAll:()=>[green] });
  const page = start({origin:intOrigin,path:'/student/virtual_school/index.php',query:'',
    selectors:{'.retroshadow':element('ระดับชั้น มัธยมศึกษาปีที่ 6 ภาคเรียนที่ 2 วิชาภาษาอังกฤษ')},
    lists:{'.panel-warning':[chapter.node],'a.exam[examtype="P"][href]':[chapter.pre],'a.exam[examtype="F"]':[final]}});
  const normal={...intScope,mode:'final',retryUntilPerfect:false};
  assert.equal(page({action:'advance_subject',scope:normal}).result.action,'opened');
  assert.equal(final.clicks,1);
  assert.equal(page({action:'inspect_page'}).result.course.navigation.levelId,'w2');
  assert.equal(page({action:'advance_subject',scope:{...normal,intActivity:{kind:'exam',examType:'F',finalResult:{correct:35,total:50}}}}).result.mode,'complete');
  assert.equal(final.clicks,1,'Normal stops after this one submitted attempt');
  final.disabled=true;
  assert.equal(page({action:'advance_subject',scope:normal}).result.mode,'scope_boundary');
  assert.equal(final.clicks,1,'disabled controls cannot be bypassed');
}
// Returning from review follows remembered opaque level→term→subject controls.
{
  const levelSelector='a.term[href="check_error.php"][level][ranglevel]';
  const termSelector='a.subject[href="check_error.php"][level][ranglevel][termid]';
  const subjectSelector='a.learn[href="check_error.php"][subj][term][level][ranglevel]';
  const lists={};
  const subject=element('',{attributes:{href:'check_error.php',level:'w2',ranglevel:'u2',term:'r2',subj:'q294'}});
  const term=element('',{attributes:{href:'check_error.php',level:'w2',ranglevel:'u2',termid:'r2'},click:()=>{lists[termSelector]=[];lists[subjectSelector]=[subject];}});
  const level=element('',{attributes:{href:'check_error.php',level:'w2',ranglevel:'u2'},click:()=>{lists[levelSelector]=[];lists[termSelector]=[term];}});
  lists[levelSelector]=[level];
  const page=start({origin:intOrigin,path:'/student/virtual_school/index.php',query:'',lists});
  const scoped={...intScope,mode:'final',retryUntilPerfect:true,navigation:{levelId:'w2',termId:'r2',rangeId:'u2'},intActivity:{kind:'exam',examType:'F',finalResult:{correct:48,total:50},reviewedQuestions:Array.from({length:50},(_,i)=>i+1)}};
  assertError(page({action:'advance_subject',scope:{...scoped,navigation:{...scoped.navigation,levelId:'WRONG'}}}),/return controls/);
  assert.equal(level.clicks,0);
  assertError(page({action:'advance_subject',scope:{...scoped,intActivity:{...scoped.intActivity,reviewedQuestions:[1]}}}),/loading/);
  assert.equal(page({action:'advance_subject',scope:scoped}).result.action,'selected_level');
  assert.equal(page({action:'advance_subject',scope:scoped}).result.action,'selected_term');
  assert.equal(page({action:'advance_subject',scope:scoped}).result.action,'reopened_subject');
  assert.equal(subject.clicks,1);
}
console.log('Normal retake and Loop return passed: completed clickable final, one attempt, disabled refusal, exact remembered level/term/subject, incomplete-review refusal');
