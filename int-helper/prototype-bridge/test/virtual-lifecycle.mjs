import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const contentSource = readFileSync(new URL("extension/content-script.js", root), "utf8");
const workerSource = readFileSync(new URL("extension/service-worker.js", root), "utf8");
const virtualOrigin = "https://main.virtualschool.club";
const virtualQuery = "?subject=MATH&level=2&term=1&year=2026&examtype=F";

const element = (innerText = "", options = {}) => ({
  innerText,
  disabled: false,
  clicks: 0,
  title: "",
  getAttribute: (name) => options.attributes?.[name] ?? null,
  getClientRects: () => options.hidden ? [] : [1],
  classList: { contains: (name) => (options.classes || []).includes(name) },
  querySelector: (selector) => options.query?.(selector) || null,
  querySelectorAll: (selector) => options.queryAll?.(selector) || [],
  click() { this.clicks += 1; options.click?.(this); },
  ...options,
});

const startContent = ({ path = "/StudyCourse", query = virtualQuery, bodyText = "", controls = [] } = {}) => {
  let listener;
  const document = {
    body: element(bodyText),
    querySelector: (selector) => selector === ".swal2-container, [role=\"dialog\"][aria-modal=\"true\"]" ? null : null,
    querySelectorAll: (selector) => selector === "button, a" || selector === "a, button" ? controls : [],
    getElementById: () => null,
  };
  runInNewContext(contentSource, {
    URL,
    document,
    globalThis: {},
    setInterval: () => 0,
    location: { hostname: new URL(virtualOrigin).hostname, pathname: path, href: virtualOrigin + path + query },
    chrome: { runtime: { sendMessage: async () => {}, onMessage: { addListener: (fn) => { listener = fn; } } } },
  });
  return (message) => {
    let response;
    listener(message, null, (value) => { response = value; });
    return response;
  };
};

const startDynamicContent = (state, query = virtualQuery) => {
  let listener;
  const body = element("");
  Object.defineProperty(body, "innerText", { configurable: true, get: () => state.bodyText || "" });
  const document = {
    body,
    querySelector: (selector) => selector === ".swal2-container, [role=\"dialog\"][aria-modal=\"true\"]" ? null : null,
    querySelectorAll: (selector) => selector === "button, a" || selector === "a, button" ? (state.controls || []) : [],
    getElementById: () => null,
  };
  const location = {
    hostname: new URL(virtualOrigin).hostname,
    get pathname() { return state.path; },
    get href() { return virtualOrigin + state.path + query; },
  };
  runInNewContext(contentSource, {
    URL,
    document,
    globalThis: {},
    setInterval: () => 0,
    location,
    chrome: { runtime: { sendMessage: async () => {}, onMessage: { addListener: (fn) => { listener = fn; } } } },
  });
  return { call: (message) => {
    let response;
    listener(message, null, (value) => { response = value; });
    return response;
  }, location };
};

const virtualScope = { origin: virtualOrigin, subjectCode: "MATH", level: "2", term: "1", year: "2026", mode: "final" };

// The observed Virtual all-question review route has the same return control
// as the single-question route. A bound below-full Loop may return to the
// overview and enter the same final; a full result and Normal result stop.
{
  const state = { path: "/AllExamAnswers", bodyText: "คะแนนรวม 2/3", controls: [] };
  const final = element("ทำแบบทดสอบปลายภาค");
  final.click = () => { final.clicks += 1; state.path = "/Exam"; };
  const back = element("กลับไปหน้าเรียน");
  back.click = () => { back.clicks += 1; state.path = "/StudyCourse"; state.controls = [final]; };
  state.controls = [back];
  const page = startDynamicContent(state, "?subject=MATH&level=2&term=1&year=2026&examtype=F");
  const belowFull = { ...virtualScope, retryUntilPerfect: true,
    virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1", submitted: true,
      reviewBound: true, reviewComplete: true, finalResult: { correct: 2, total: 3 }, totalQuestions: 3 } };
  const returned = page.call({ action: "advance_subject", scope: belowFull });
  assert.equal(returned.ok, true, returned.error);
  assert.equal(returned.result.action, "returned");
  assert.equal(state.path, "/StudyCourse");
  const retry = page.call({ action: "advance_subject", scope: belowFull,
    virtualAttemptId: "attempt-2", virtualAttemptEnteredAt: 123 });
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.result.virtualFinalOpened, true);
  assert.equal(retry.result.virtualAttemptId, "attempt-2");
  assert.equal(final.clicks, 1);

  const unboundState = { path: "/AllExamAnswers", bodyText: "คะแนนรวม 2/3", controls: [] };
  const unboundFinal = element("ทำแบบทดสอบปลายภาค");
  const unboundBack = element("กลับไปหน้าเรียน");
  unboundBack.click = () => { unboundBack.clicks += 1; unboundState.path = "/StudyCourse"; unboundState.controls = [unboundFinal]; };
  unboundState.controls = [unboundBack];
  const unboundPage = startDynamicContent(unboundState);
  const unboundScope = { ...virtualScope, retryUntilPerfect: true,
    virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1", submitted: true,
      reviewBound: false, reviewComplete: false, finalResult: { correct: 2, total: 3 }, totalQuestions: 3 } };
  assert.equal(unboundPage.call({ action: "advance_subject", scope: unboundScope }).result.action, "returned");
  const blockedRetry = unboundPage.call({ action: "advance_subject", scope: unboundScope });
  assert.equal(blockedRetry.result.mode, "review_required");
  assert.equal(unboundFinal.clicks, 0);

  const fullState = { path: "/StudyCourse", bodyText: "", controls: [] };
  const fullFinal = element("ทำแบบทดสอบปลายภาค");
  fullState.controls = [fullFinal];
  const fullPage = startDynamicContent(fullState);
  const full = fullPage.call({ action: "advance_subject", scope: { ...virtualScope, retryUntilPerfect: true,
    virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1", submitted: true,
      reviewBound: true, reviewComplete: true, finalResult: { correct: 3, total: 3 }, totalQuestions: 3 } } });
  assert.equal(full.ok, true, full.error);
  assert.equal(full.result.mode, "complete");
  assert.equal(fullFinal.clicks, 0);

  const normalState = { path: "/StudyCourse", bodyText: "", controls: [] };
  const normalFinal = element("ทำแบบทดสอบปลายภาค");
  normalState.controls = [normalFinal];
  const normalPage = startDynamicContent(normalState);
  const normal = normalPage.call({ action: "advance_subject", scope: { ...virtualScope,
    virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1", submitted: true,
      reviewBound: false, finalResult: { correct: 2, total: 3 }, totalQuestions: 3 } } });
  assert.equal(normal.ok, true, normal.error);
  assert.equal(normal.result.mode, "complete");
  assert.equal(normalFinal.clicks, 0);
}

{
  const final = element("ทำแบบทดสอบปลายภาค");
  const page = startContent({ controls: [final] });
  const opened = page({ action: "advance_subject", scope: virtualScope });
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.result.virtualFinalOpened, true);
  assert.equal(opened.result.observedAnswersReset, true);
  assert.equal(final.clicks, 1);

  const begun = page({ action: "begin_virtual_attempt", attemptId: "attempt-1", scope: virtualScope });
  assert.equal(begun.ok, true, begun.error);
  assert.equal(begun.result.observedAnswersReset, true);
}
{
  const page = startContent({ path: "/Exam", bodyText: "ส่งคำตอบเรียบร้อยแล้ว" });
  const status = page({ action: "read_submission_status" });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.result.submitted, true);
  assert.equal(status.result.marker, "ส่งคำตอบเรียบร้อยแล้ว");
  const terminal = page({ action: "advance_subject", scope: virtualScope });
  assert.equal(terminal.ok, true, terminal.error);
  assert.equal(terminal.result.terminalStatus, true);
  assert.equal(terminal.result.submittedMarker, "ส่งคำตอบเรียบร้อยแล้ว");
  const loopTerminal = page({ action: "advance_subject", scope: { ...virtualScope, retryUntilPerfect: true,
    virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1", reviewBound: false } } });
  assert.equal(loopTerminal.ok, true, loopTerminal.error);
  assert.equal(loopTerminal.result.mode, "review_required");
}

// The worker harness exercises final entry, normal answer capture, idempotent
// confirmation, and a fresh retry attempt without touching a live browser.
{
  let handler;
  let uuid = 0;
  let questionNumber = 1;
  let submittedMarker = false;
  let advanceResult = { mode: "overview", action: "opened", virtualFinalOpened: true };
  const sent = [];
  const question = () => ({ examCode: `Q:${questionNumber}`, questionNumber, totalQuestions: 3,
    questionText: `Question ${questionNumber}`, questionImage: null,
    choices: [{ index: 1, text: `A${questionNumber}` }, { index: 2, text: `B${questionNumber}` }], images: [], done: false });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() {}
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const pageInfo = { origin: virtualOrigin, path: "/StudyCourse",
    course: { subjectCode: "MATH", level: "2", term: "1", year: "2026" }, chapters: [] };
  const chrome = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    runtime: { getManifest: () => ({ version: "test" }), getURL: (value) => `chrome-extension://test/${value}`, onMessage: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 7, active: true, url: `${virtualOrigin}/StudyCourse${virtualQuery}` }],
      sendMessage: async (id, message) => {
        sent.push({ id, ...message });
        if (message.action === "page_version") return { ok: true, result: { contentVersion: "test" } };
        if (message.action === "inspect_page") return { ok: true, result: pageInfo };
        if (message.action === "advance_subject") return { ok: true, result: advanceResult.virtualFinalOpened
          ? { ...advanceResult, virtualAttemptId: message.virtualAttemptId, virtualAttemptEnteredAt: message.virtualAttemptEnteredAt }
          : advanceResult };
        if (message.action === "begin_virtual_attempt") return { ok: true, result: { attemptId: message.attemptId, observedAnswersReset: true } };
        if (message.action === "read_question") return { ok: true, result: question() };
        if (message.action === "apply_answer") return { ok: true, result: { examCode: `Q:${questionNumber}`, selected: 1, saved: null, persistence: "unverified_until_submission" } };
        if (message.action === "navigate_next") {
          if (questionNumber === 3) return { ok: true, result: { done: true } };
          questionNumber += 1;
          return { ok: true, result: { done: false } };
        }
        if (message.action === "read_submission_status") return { ok: true, result: { submitted: submittedMarker, marker: submittedMarker ? "submitted" : null } };
        if (message.action === "submit_exam") return { ok: true, result: { action: "confirmed" } };
        return { ok: true, result: { action: "confirmed" } };
      },
    },
  };
  runInNewContext(workerSource + "\nglobalThis.expose(handleRequest);", {
    chrome,
    WebSocket: Socket,
    Date,
    URL,
    console,
    crypto: { randomUUID: () => `attempt-${++uuid}` },
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout() {},
    setInterval() {},
    expose: (fn) => { handler = fn; },
  });

  const setup = await handler("set_scope", { subjectCode: "MATH", mode: "final", retryUntilPerfect: false, autoSubmit: true }, 17373);
  assert.equal(setup.scope.origin, virtualOrigin);
  const entered = await handler("advance_subject", {}, 17373);
  assert.equal(entered.virtualActivity.attemptId, "attempt-1");
  assert.ok(Number.isFinite(entered.virtualActivity.enteredAt));
  assert.equal(sent.filter((message) => message.action === "begin_virtual_attempt").length, 0,
    "entry metadata must cross the navigation click without a post-click reset message");
  const firstEntry = sent.find((message) => message.action === "advance_subject");
  assert.equal(firstEntry.virtualAttemptId, "attempt-1");

  // A historical submitted banner is terminal evidence for display only until
  // this bridge has confirmed the current attempt.
  submittedMarker = true;
  const historical = await handler("submit_current_exam", { examCode: "Q:1" }, 17373);
  assert.equal(historical.action, "already_submitted");
  assert.equal(historical.ownedAttempt, false);
  submittedMarker = false;
  assert.equal(entered.virtualActivity.submitted, false);

  for (let n = 1; n <= 3; n += 1) {
    const answered = await handler("answer_and_next", { examCode: `Q:${n}`, choiceIndex: 1, save: false }, 17373);
    assert.equal(answered.answeredExamCode, `Q:${n}`);
    if (n < 3) assert.equal(answered.done, false);
    else assert.equal(answered.done, true);
  }
  assert.equal((await handler("submit_current_exam", { examCode: "Q:3" }, 17373)).action, "confirmed");
  assert.equal((await handler("submit_current_exam", { examCode: "Q:3" }, 17373)).action, "confirmation_pending");
  submittedMarker = true;
  const terminal = await handler("submit_current_exam", { examCode: "Q:3" }, 17373);
  assert.equal(terminal.action, "already_submitted");
  assert.equal(terminal.submitted, true);
  const repeatedTerminal = await handler("submit_current_exam", { examCode: "Q:3" }, 17373);
  assert.equal(repeatedTerminal.ownedAttempt, true, "re-reading the same owned terminal marker stays idempotent");

  const loop = await handler("set_exam_loop", { enabled: true }, 17373);
  assert.equal(loop.loopMode, "loop_until_full");
  assert.equal(loop.scope.retryUntilPerfect, true);
  const pacing = await handler("set_exam_pacing", { durationMinutes: 0 }, 17373);
  assert.equal(pacing.scope.durationMinutes, 0);
  submittedMarker = false;
  questionNumber = 1;
  const retry = await handler("advance_subject", {}, 17373);
  assert.equal(retry.virtualActivity.attemptId, "attempt-2");
  assert.equal(retry.virtualActivity.attempt, 2);
  assert.equal(retry.virtualActivity.submitted, false);
  assert.equal(sent.filter((message) => message.action === "begin_virtual_attempt").length, 0);
  assert.equal(sent.filter((message) => message.action === "advance_subject").at(-1).virtualAttemptId, "attempt-2");
}

// Binding is accepted only for a complete review tied to the opened attempt;
// the score is recomputed from the saved selections even when the review has
// no selected-answer markers of its own.
{
  let bind;
  const pure = workerSource.slice(workerSource.indexOf("const normalizeReviewText ="), workerSource.indexOf("const mutations ="));
  runInNewContext(pure + "\nglobalThis.expose(bindVirtualReview);", {
    expose: (fn) => { bind = fn; },
    isVirtualScope: (scope) => scope?.origin === virtualOrigin,
  });
  const answer = (number, selectedChoiceIndex) => ({ questionNumber: number, questionText: ` Question ${number} `,
    questionImage: null, selectedChoiceIndex, choices: [{ index: 1, text: `A${number}` }, { index: 2, text: `B${number}` }] });
  const answers = new Map([ [1, answer(1, 2)], [2, answer(2, 2)], [3, answer(3, 1)] ]);
  const review = (number, correctChoiceIndex) => ({ ...answer(number, null), questionText: `Question ${number}`,
    correctChoiceIndex, selectedChoiceIndex: null, selectionState: "unknown", correctness: "unverified",
    verificationSource: "Virtual School explicit correct-answer label", evidence: `Question ${number}: explicit correct answer` });
  const session = { submitted: true, attemptAnswers: answers, reviewOpened: { attemptId: "attempt-1" }, scope: {
    origin: virtualOrigin, virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1" } } };
  const result = bind(session, { reviewLayout: "all", reviewComplete: true, totalQuestions: 3, score: { correct: 1, total: 3 },
    examCode: null, verifiedReviews: [review(1, 1), review(2, 2), review(3, 2)] });
  assert.equal(result.reviewBound, true);
  assert.equal(result.boundAttemptId, "attempt-1");
  assert.equal(result.rejectedReviews.length, 2);
  assert.ok(result.rejectedReviews.every((item) => item.verificationSource === "Virtual School explicit correct-answer label" && item.selectionSource === "bound_attempt_ledger"));
  assert.deepEqual(session.scope.virtualActivity.finalResult, { correct: 1, total: 3 });

  const wrongScore = bind({ ...session, scope: { ...session.scope, virtualActivity: { ...session.scope.virtualActivity, finalResult: undefined } } },
    { reviewLayout: "all", reviewComplete: true, totalQuestions: 3, score: { correct: 2, total: 3 }, examCode: null,
      verifiedReviews: [review(1, 1), review(2, 2), review(3, 2)] });
  assert.equal(wrongScore.reviewBound, false);
  assert.equal(wrongScore.reviewBindingError, "Virtual review correctness does not match its observed score");
  assert.equal(session.scope.virtualActivity.finalResult.correct, 1, "failed binding must not replace the bound score");

  const selectedConflict = bind(session, { reviewLayout: "all", reviewComplete: true, totalQuestions: 3,
    score: { correct: 1, total: 3 }, examCode: null, verifiedReviews: [
      { ...review(1, 1), selectedChoiceIndex: 1, selectionState: "selected", correctness: "correct" },
      review(2, 2), review(3, 2),
    ] });
  assert.equal(selectedConflict.reviewBound, false, "visible selected-choice evidence must match the attempt ledger even when totals agree");
  const unansweredConflict = bind(session, { reviewLayout: "all", reviewComplete: true, totalQuestions: 3,
    score: { correct: 1, total: 3 }, examCode: null, verifiedReviews: [
      { ...review(1, 1), selectionState: "unanswered", correctness: "incorrect" }, review(2, 2), review(3, 2),
    ] });
  assert.equal(unansweredConflict.reviewBound, false, "an unanswered historical review cannot bind to an answered attempt");

  const wrongOpenedAttempt = bind({ submitted: true, attemptAnswers: answers, reviewOpened: { attemptId: "other" }, scope: {
    origin: virtualOrigin, virtualActivity: { kind: "exam", examType: "F", attemptId: "attempt-1" } } },
    { reviewLayout: "all", reviewComplete: true, totalQuestions: 3, score: { correct: 1, total: 3 }, examCode: null,
      verifiedReviews: [review(1, 1), review(2, 2), review(3, 2)] });
  assert.equal(wrongOpenedAttempt.reviewBound, false);
}

console.log("Virtual lifecycle passed: entry/reset, normal capture, confirmation/submission separation, arbitrary totals, retry reset, bound review score and rejection evidence");
