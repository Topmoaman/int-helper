import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
let mockUpdateStatus;
const port = 17473;
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=";
const demoCourse = { origin: "https://int-project.com", subjectCode: "ENG", subjectName: "ภาษาอังกฤษ", level: "6", term: "2", year: "2026" };
const state = { bridge: "starting", extension: "disconnected", current: null, lastAction: null, error: null };
let client;
let transport;
const extensions = [];
let batchCursor = null;
const batchActions = [];
const historyDirectory = mkdtempSync(join(tmpdir(), "int-history-demo-"));

const questions = [
  {
    ok: true,
    questionNumber: 1,
    examCode: "DEMO-1",
    questionText: "How many variables are shown?",
    questionImage: "https://example.test/q1.png",
    choices: [1, 2, 3, 4].map((index) => ({ index, text: String(index), image: null, checked: false })),
    done: false,
    images: [{ role: "question", mimeType: "image/png", data: tinyPng }],
  },
  {
    ok: true,
    questionNumber: 2,
    examCode: "DEMO-2",
    questionText: "The bridge returned the next question in the answer call.",
    questionImage: null,
    choices: [
      { index: 1, text: "True", image: null, checked: false },
      { index: 2, text: "False", image: null, checked: false },
    ],
    done: false,
    images: [],
  },
];

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));

const createBridge = async (name, { targetPort = port, historyDir = historyDirectory } = {}) => {
  const bridgeTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.cjs"],
    cwd: root,
    env: { ...cleanEnv, INT_PRACTICE_BRIDGE_PORT: String(targetPort), INT_PRACTICE_HISTORY_DIR: historyDir },
    stderr: "pipe",
  });
  const bridgeClient = new Client({ name, version: "0.1.0" });
  await bridgeClient.connect(bridgeTransport);
  return { client: bridgeClient, transport: bridgeTransport };
};

const startBridge = async () => {
  ({ client, transport } = await createBridge("int-helper-bridge-demo"));
  state.bridge = "connected";
};

const connectMockExtension = async (targetPort = port) => {
  const extension = new WebSocket(`ws://127.0.0.1:${targetPort}`, { origin: "chrome-extension://prototype" });
  await new Promise((resolve, reject) => {
    extension.once("open", resolve);
    extension.once("error", reject);
  });
  extension.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    if (batchCursor !== null && ["read_current_question", "answer_and_next"].includes(message.action)) {
      if (message.action === "answer_and_next") { batchActions.push(message.payload); batchCursor++; }
      const question = questions[Math.min(batchCursor, questions.length - 1)];
      const result = { ...question, ...(message.action === "answer_and_next" ? { selected: message.payload.choiceIndex, saved: message.payload.save, done: batchCursor >= questions.length } : {}) };
      extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
      return;
    }
    const result = message.action === "set_scope" ? { scope: { ...demoCourse, ...message.payload } } : message.action === "set_exam_loop"
      ? { scope: { ...demoCourse, mode: "final", retryUntilPerfect: message.payload.enabled }, loopMode: message.payload.enabled ? "loop_until_50" : "normal" }
      : message.action === "read_exam_result"
      ? { ...questions[0], resultToken: "review-token", correctChoiceIndex: 2, selectedChoiceIndex: 1,
          correctness: "incorrect", verificationSource: "INT explicit correct-answer label", evidence: "คำตอบข้อที่ถูก 2.", verifiedReviews: [{ ...questions[1], selectedChoiceIndex: 1, correctChoiceIndex: 1, correctness: "correct", verificationSource: "INT submitted answer-sheet marker", evidence: "Question 2: correct" }] }
      : message.action === "open_answer_review" ? (message.payload.step === "question" ? { ...questions[0], resultToken: "after-jump", correctChoiceIndex: 2, selectedChoiceIndex: 1, correctness: "incorrect", verificationSource: "INT explicit correct-answer label", evidence: "combined navigation evidence" } : { ok: true, action: message.payload.step })
      : message.action === "read_current_question"
      ? questions[0]
      : message.action === "advance_subject"
        ? { ok: true, mode: "overview", action: "opened" }
        : message.action === "complete_current_lesson"
          ? { ok: true, mode: "exam", pretest: false, needsAnswers: true, actions: 4 }
        : message.action === "submit_current_exam"
          ? { ok: true, mode: "submission", action: "opened" }
          : { selected: message.payload.choiceIndex, saved: message.payload.save, ...questions[1] };
    extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result, updateStatus: mockUpdateStatus }));
  });
  extension.on("close", () => (state.extension = "disconnected"));
  extensions.push(extension);
  state.extension = "connected";
  return extension;
};

const readCurrent = async () => {
  const result = await client.callTool({ name: "read_current_question", arguments: {} });
  state.current = result.structuredContent;
  state.lastAction = "read_current_question";
  state.error = null;
  return result;
};

const answerAndNext = async () => {
  if (!state.current) throw new Error("Read a question first");
  const result = await client.callTool({
    name: "answer_and_next",
    arguments: { choiceIndex: 2, examCode: state.current.examCode, save: false },
  });
  state.current = result.structuredContent;
  state.lastAction = "answer_and_next(choiceIndex=2)";
  state.error = null;
  return result;
};

const stop = async () => {
  for (const extension of extensions) extension.close();
  await client?.close();
};

const runVirtualTransport = async () => {
  const virtualPort = port + 2;
  const virtualHistory = mkdtempSync(join(tmpdir(), "virtual-history-demo-"));
  const virtualCourse = { origin: "https://main.virtualschool.club", subjectCode: "BIO-22", subjectName: "Biology", level: "J", term: "2", year: "2569" };
  const virtualCourseWithoutName = { ...virtualCourse };
  delete virtualCourseWithoutName.subjectName;
  const intCourse = { origin: "https://int-project.com", subjectCode: "BIO-22", subjectName: "Biology", level: "J", term: "2", year: "2569" };
  const q1 = { ok: true, questionNumber: 1, totalQuestions: 2, examCode: "V:1", questionText: "Virtual question one", questionImage: null,
    choices: [{ index: 1, text: "A", image: null, checked: false }, { index: 2, text: "B", image: null, checked: false }], done: false, images: [] };
  const q2 = { ok: true, questionNumber: 2, totalQuestions: 2, examCode: "V:2", questionText: "Virtual question two", questionImage: null,
    choices: [{ index: 1, text: "C", image: null, checked: false }, { index: 2, text: "D", image: null, checked: false }], done: false, images: [] };
  const q1Shuffled = { ...q1, choices: [{ ...q1.choices[1], index: 1 }, { ...q1.choices[0], index: 2 }] };
  const q2Shuffled = { ...q2, choices: [{ ...q2.choices[1], index: 1 }, { ...q2.choices[0], index: 2 }] };
  const q3 = { ok: true, questionNumber: 3, totalQuestions: 3, examCode: "V:3", questionText: "Unseen Virtual question", questionImage: null,
    choices: [{ index: 1, text: "new", image: null }], done: false, images: [] };
  let course = virtualCourse;
  let batchMode = "unknown";
  let batchStep = 0;
  let delayReview = false;
  let delayQuestion = false;
  let delayAnswer = false;
  let virtualReviewBound = false;
  const batchActions = [];
  const actionTrace = [];
  let questionImagesPending = false;
  const bridge = await createBridge("virtual-practice-bridge-demo", { targetPort: virtualPort, historyDir: virtualHistory });
  const extension = new WebSocket(`ws://127.0.0.1:${virtualPort}`, { origin: "chrome-extension://prototype" });
  await new Promise((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
  extension.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    actionTrace.push(message.action);
    let result;
    if (message.action === "set_scope") {
      course = message.payload.subjectCode === "INT" ? intCourse : (message.payload.subjectCode === "BIO-22" && batchMode === "named-off" ? virtualCourseWithoutName : virtualCourse);
      result = { scope: { ...course, ...message.payload } };
    } else if (message.action === "resume_scope") {
      result = { scope: { ...virtualCourse, mode: "final", retryUntilPerfect: true }, resumed: true,
        resumeToken: message.payload.resumeToken, historyEnabled: message.payload.resumeToken.endsWith("1"), restoredAnswerCount: 2 };
    } else if (message.action === "sync_history_state") {
      result = { enabled: message.historyEnabled };
    } else if (message.action === "read_exam_result") {
      result = { ...q1, scope: course, resultToken: "VRESULT", reviewBound: virtualReviewBound, score: { correct: 2, total: 2 },
        selectedChoiceIndex: null, correctness: "unverified", correctChoiceIndex: 2,
        verificationSource: "Virtual School explicit correct-answer label", evidence: "คำตอบที่ถูกต้อง ข",
        verifiedReviews: [
          { ...q1, scope: course, selectedChoiceIndex: null, correctness: "unverified", correctChoiceIndex: 2,
            verificationSource: "Virtual School explicit correct-answer label", evidence: "ข้อ 1 เฉลย ข" },
          { ...q2, scope: course, selectedChoiceIndex: null, correctness: "unverified", correctChoiceIndex: 2,
            verificationSource: "Virtual School explicit correct-answer label", evidence: "ข้อ 2 เฉลย ง" },
        ] };
    } else if (message.action === "open_answer_review") {
      result = message.payload.step === "return" ? { ok: true, action: "returned", done: false } : { ...(message.payload.questionNumber === 2 ? q2Shuffled : q1Shuffled), scope: course,
        resultToken: "VRESULT", reviewBound: virtualReviewBound, action: message.payload.step, selectedChoiceIndex: null, correctness: "unverified",
        correctChoiceIndex: 1, verificationSource: "Virtual School explicit correct-answer label", evidence: "review destination" };
    } else if (message.action === "read_current_question") {
      result = { ...q1Shuffled, ...(questionImagesPending ? { imagesPending: true, ready: false, imageWarning: "Image request failed (403)", images: [] } : {}) };
    } else if (message.action === "answer_and_next") {
      batchActions.push(message.payload);
      if (batchMode === "unknown") result = { ...q3, selected: message.payload.choiceIndex, saved: null, done: false };
      else if (batchStep++ === 0) result = { ...q2Shuffled, selected: message.payload.choiceIndex, saved: null, done: false };
      else result = { ok: true, examCode: "V:2", selected: message.payload.choiceIndex, saved: null, done: true, images: [] };
    } else {
      result = { ok: true, scope: course, action: message.action };
    }
    const send = () => extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
    if ((message.action === "read_exam_result" && delayReview) || (message.action === "read_current_question" && delayQuestion) || (message.action === "answer_and_next" && delayAnswer)) setTimeout(send, 50);
    else send();
  });
  try {
    const listed = await bridge.client.listTools();
    const reviewTool = listed.tools.find((tool) => tool.name === "open_answer_review");
    assert.equal(reviewTool.inputSchema.properties.questionNumber.maximum, 1000);
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "BIO-22", mode: "final" } });
    await bridge.client.callTool({ name: "set_question_history", arguments: { enabled: true } });
    const unbound = await bridge.client.callTool({ name: "read_exam_result", arguments: {} });
    assert.equal(unbound.structuredContent.historyVerificationPending, true);
    assert.equal(unbound.structuredContent.evidencePending, true);
    assert.equal(existsSync(unbound.structuredContent.historyFile), false, "unbound Virtual evidence does not create a journal");
    virtualReviewBound = true;
    const review = await bridge.client.callTool({ name: "read_exam_result", arguments: {} });
    assert.equal(review.structuredContent.verificationSource, "Virtual School explicit correct-answer label");
    const historyFile = review.structuredContent.historyFile;
    const saved = readFileSync(historyFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(saved.filter((record) => record.type === "verified_answer").length, 2);
    assert.ok(saved.filter((record) => record.type === "verified_answer").every((record) => record.verificationSource === "Virtual School explicit correct-answer label"));
    const remapped = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(remapped.structuredContent.verifiedAnswer.choiceIndex, 1);
    const nav = await bridge.client.callTool({ name: "open_answer_review", arguments: { resultToken: "VRESULT", step: "question", questionNumber: 1 } });
    assert.equal(nav.structuredContent.action, "question");
    const beforeReturn = readFileSync(historyFile, "utf8");
    const returned = await bridge.client.callTool({ name: "open_answer_review", arguments: { resultToken: "VRESULT", step: "return" } });
    assert.equal(returned.structuredContent.action, "returned");
    assert.equal(returned.structuredContent.choices, undefined);
    assert.equal(returned.structuredContent.historyWarning, undefined);
    assert.equal(readFileSync(historyFile, "utf8"), beforeReturn, "return acknowledgements do not write or erase answer evidence");
    const afterReturn = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(afterReturn.structuredContent.verifiedAnswer.choiceIndex, 1, "verified answers remain reusable after leaving review");
    const beforeQuestionRace = readFileSync(historyFile, "utf8");
    delayQuestion = true;
    const pendingQuestion = bridge.client.callTool({ name: "read_current_question", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "INT", mode: "final" } });
    delayQuestion = false;
    const skippedQuestion = await pendingQuestion;
    assert.match(skippedQuestion.structuredContent.historyWarning, /writer or scoped course changed/u);
    assert.equal(skippedQuestion.structuredContent.examCode, "V:1");
    assert.equal(readFileSync(historyFile, "utf8"), beforeQuestionRace, "scope-raced question read must not append to the old journal");
    // A scope change while the browser read is in flight must leave the old
    // Virtual journal untouched.
    delayReview = true;
    const pendingReview = bridge.client.callTool({ name: "read_exam_result", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "INT", mode: "final" } });
    const skippedReview = await pendingReview;
    assert.match(skippedReview.structuredContent.historyWarning, /writer or scoped course changed/u);
    assert.equal(readFileSync(historyFile, "utf8").trim().split("\n").map(JSON.parse).filter((record) => record.type === "verified_answer").length, 2);
    delayReview = false;
    batchMode = "named-off";
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "BIO-22", mode: "final" } });
    batchMode = "unknown";
    const answerSeed = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    const answerHistoryFile = answerSeed.structuredContent.historyFile;
    const beforeAnswerRace = readFileSync(answerHistoryFile, "utf8");
    delayAnswer = true;
    const pendingAnswer = bridge.client.callTool({ name: "answer_and_next", arguments: { examCode: "V:1", choiceIndex: 1, save: false } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "INT", mode: "final" } });
    delayAnswer = false;
    const skippedAnswer = await pendingAnswer;
    assert.match(skippedAnswer.structuredContent.historyWarning, /writer or scoped course changed/u);
    assert.equal(skippedAnswer.structuredContent.selected, 1, "scope-raced answer preserves the browser result");
    const afterAnswerRace = readFileSync(answerHistoryFile, "utf8").trim().split("\n").map(JSON.parse);
    const beforeAnswerRecords = beforeAnswerRace.trim().split("\n").map(JSON.parse);
    assert.equal(afterAnswerRace.filter((record) => record.type === "answer_returned").length,
      beforeAnswerRecords.filter((record) => record.type === "answer_returned").length,
      "scope-raced answer must not append answer_returned");
    assert.equal(afterAnswerRace.some((record) => record.type === "question" && record.question?.examCode === "V:3"), false,
      "scope-raced answer must not append its next question");
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "BIO-22", mode: "final" } });
    batchMode = "unknown";
    const toggleSeed = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    const toggleHistoryFile = toggleSeed.structuredContent.historyFile;
    delayAnswer = true;
    const pendingHistoryToggleAnswer = bridge.client.callTool({ name: "answer_and_next", arguments: { examCode: "V:1", choiceIndex: 1, save: false } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const historyBeforeToggle = readFileSync(toggleHistoryFile, "utf8");
    await bridge.client.callTool({ name: "set_question_history", arguments: { enabled: false } });
    const replacement = await bridge.client.callTool({ name: "set_question_history", arguments: { enabled: true } });
    delayAnswer = false;
    const skippedHistoryToggleAnswer = await pendingHistoryToggleAnswer;
    assert.match(skippedHistoryToggleAnswer.structuredContent.historyWarning, /writer or scoped course changed/u);
    assert.equal(readFileSync(toggleHistoryFile, "utf8"), historyBeforeToggle, "history writer replacement must not append the stale answer");
    assert.ok(replacement.structuredContent.historyFile, "history re-enable returns the replacement writer");
    actionTrace.length = 0;
    const staleCurrent = await bridge.client.callTool({ name: "answer_and_next", arguments: { examCode: "V:3", choiceIndex: 1, save: false } });
    assert.equal(actionTrace[0], "read_current_question", "a stale answer response must not repopulate currentQuestion after writer replacement");
    assert.equal(staleCurrent.structuredContent.mode, "resync");
    batchStep = 0;
    const unknown = await bridge.client.callTool({ name: "answer_known_questions", arguments: { maxQuestions: 20 } });
    assert.equal(unknown.structuredContent.knownAnswersApplied, 1);
    assert.equal(unknown.structuredContent.batchStopReason, "needs_reasoning");
    batchMode = "done";
    batchStep = 0;
    const done = await bridge.client.callTool({ name: "answer_known_questions", arguments: { maxQuestions: 20 } });
    assert.equal(done.structuredContent.knownAnswersApplied, 2);
    assert.equal(done.structuredContent.batchStopReason, "exam_answered");
    assert.ok(batchActions.every((payload) => payload.save === false), "Virtual known batches never use INT save=true");
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "INT", mode: "final" } });
    const isolated = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(isolated.structuredContent.verifiedAnswer, null, "same question does not cross site identity");
    batchMode = "named-off";
    await bridge.client.callTool({ name: "set_scope", arguments: { subjectCode: "BIO-22", mode: "final" } });
    const unnamed = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(unnamed.structuredContent.verifiedAnswer.choiceIndex, 1, "Virtual display-name changes retain the bank");
    questionImagesPending = true;
    const unreadable = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(unreadable.structuredContent.verifiedAnswer, null);
    assert.equal(unreadable.structuredContent.historyMatch, "question_incomplete");
    const beforeImageAnswers = batchActions.length;
    const imageBlocked = await bridge.client.callTool({ name: "answer_and_next", arguments: { examCode: "V:1", choiceIndex: 1, save: false } });
    assert.equal(imageBlocked.structuredContent.answerApplied, false);
    const imageBatch = await bridge.client.callTool({ name: "answer_known_questions", arguments: { maxQuestions: 20 } });
    assert.equal(imageBatch.structuredContent.batchStopReason, "images_pending");
    assert.equal(batchActions.length, beforeImageAnswers, "history and batches never dispatch an unreadable image answer");
    questionImagesPending = false;
    const imageReady = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(imageReady.structuredContent.verifiedAnswer.choiceIndex, 1);
    const resumed = await bridge.client.callTool({ name: "resume_scope", arguments: { resumeToken: "11111111-1111-4111-8111-111111111111" } });
    assert.equal(resumed.structuredContent.restoredAnswerCount, 2);
    assert.ok(resumed.structuredContent.historyFile, "resuming restores the scoped history writer before the next read");
    const reused = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(reused.structuredContent.verifiedAnswer.choiceIndex, 1);
    const withoutHistory = await bridge.client.callTool({ name: "resume_scope", arguments: { resumeToken: "11111111-1111-4111-8111-111111111112" } });
    assert.equal(withoutHistory.structuredContent.historyFile, undefined, "explicitly disabled history remains disabled even in a saved Loop");
    const historyOff = await bridge.client.callTool({ name: "read_current_question", arguments: {} });
    assert.equal(historyOff.structuredContent.historyFile, undefined);
    await bridge.client.callTool({ name: "set_question_history", arguments: { enabled: false } });
    assert.equal(actionTrace.at(-1), "sync_history_state", "history changes update the recovery checkpoint");
  } finally {
    extension.close();
    await bridge.client.close();
    rmSync(virtualHistory, { recursive: true, force: true });
  }
};

const check = async () => {
  execFileSync(process.execPath, ["test/web-adapters.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/virtual-subject-list.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/virtual-subject-list-content.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/web-adapter-worker-e2e.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/regression.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/review-fast.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/resync.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/bank-batch.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/updater.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/update-notice.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/upgrade-compat.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/virtual-review.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/virtual-history.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/virtual-lifecycle.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/normal-submission.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/target-pacing.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/server-shutdown.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/session-recovery.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/virtual-navigation-recovery.mjs"], { stdio: "inherit" });
  const firstBridge = await createBridge("int-helper-bridge-demo-1");
  const secondBridge = await createBridge("int-helper-bridge-demo-2");
  ({ client, transport } = firstBridge);
  await connectMockExtension(port);
  try {
    await connectMockExtension(port + 1);
  } catch {
    // Expected before the multi-task port fallback fix.
  }
  const listed = await client.listTools();
  const inspect = () => client.callTool({ name: "inspect_page", arguments: {} });
  assert.equal((await inspect()).structuredContent.updateNotice, undefined);
  mockUpdateStatus = { latest: "0.22.0" };
  const notification = await inspect();
  assert.equal(notification.structuredContent.updateNotice.latest, "0.22.0");
  assert.equal(JSON.parse(notification.content[0].text).updateNotice.latest, "0.22.0");
  assert.equal((await inspect()).structuredContent.updateNotice, undefined);
  assert.equal((await secondBridge.client.callTool({ name: "inspect_page", arguments: {} })).structuredContent.updateNotice.latest, "0.22.0");
  mockUpdateStatus = { latest: "0.23.0" };
  assert.equal((await inspect()).structuredContent.updateNotice.latest, "0.23.0");
  mockUpdateStatus = undefined;
  for (const name of ["set_scope", "read_subjects", "open_subject", "return_to_subjects", "set_exam_pacing", "answer_known_questions", "get_question_history_stats"]) assert.ok(listed.tools.find(tool => tool.name === name));
  assert.equal((await client.callTool({ name: "set_exam_pacing", arguments: { durationMinutes: -1 } })).isError, true);
  assert.equal((await client.callTool({ name: "set_exam_pacing", arguments: { durationMinutes: 120 } })).isError, true);
  assert.equal((await client.callTool({ name: "open_subject", arguments: { subjectCode: "MATH" } })).isError, true);
  assert.equal((await client.callTool({ name: "open_subject", arguments: { listToken: "demo", subjectCode: "MATH", cardToken: "VIRTUAL" } })).isError, true);
  assert.equal((await client.callTool({ name: "open_subject", arguments: { listToken: "demo", cardToken: "VIRTUAL" } })).isError, undefined);
  assert.equal((await client.callTool({ name: "open_subject", arguments: { listToken: "demo", subjectCode: "MATH" } })).isError, undefined);
  assert.deepEqual(listed.tools.find((tool) => tool.name === "set_current_exam_scope").inputSchema.required, ["examCode"]);
  assert.deepEqual(listed.tools.find((tool) => tool.name === "submit_current_exam").inputSchema.required, ["examCode"]);
  assert.equal((await client.callTool({ name: "submit_current_exam", arguments: {} })).isError, true);
  assert.equal((await readCurrent()).structuredContent.historyFile, undefined);
  await answerAndNext();
  assert.deepEqual(readdirSync(historyDirectory), []);
  assert.equal((await client.callTool({ name: "answer_known_questions", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "get_question_history_stats", arguments: {} })).isError, true);
  assert.equal(listed.tools.find(tool => tool.name === "set_scope").inputSchema.properties.autoSubmit.default, false);
  assert.equal((await client.callTool({ name: "set_scope", arguments: { subjectCode: "ENG", mode: "final" } })).structuredContent.scope.autoSubmit, false);
  assert.equal((await client.callTool({ name: "set_scope", arguments: { subjectCode: "ENG", mode: "final", autoSubmit: true } })).structuredContent.scope.autoSubmit, true);
  await client.callTool({ name: "set_question_history", arguments: { enabled: true } });
  const unknownBatch = await client.callTool({ name: "answer_known_questions", arguments: { maxQuestions: 20 } });
  assert.equal(unknownBatch.structuredContent.batchStopReason, "needs_reasoning");
  assert.equal(unknownBatch.structuredContent.knownAnswersApplied, 0);
  const first = await readCurrent();
  assert.equal(state.current.examCode, "DEMO-1");
  assert.equal(first.content.filter((item) => item.type === "image").length, 1);
  await answerAndNext();
  assert.equal(state.current.examCode, "DEMO-2");
  assert.equal(state.current.selected, 2);
  assert.equal((await secondBridge.client.callTool({ name: "read_current_question", arguments: {} })).structuredContent.historyFile, undefined);
  await secondBridge.client.callTool({ name: "set_question_history", arguments: { enabled: true } });
  const second = await secondBridge.client.callTool({ name: "read_current_question", arguments: {} });
  assert.equal(second.structuredContent.examCode, "DEMO-1");
  assert.notEqual(first.structuredContent.historyFile, second.structuredContent.historyFile);
  const records = readFileSync(first.structuredContent.historyFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map((r) => r.type), ["question", "question", "answer_requested", "answer_returned", "question"]);
  assert.equal(records[0].question.images[0].data, tinyPng);
  assert.ok(records.every(record => record.subject.subjectName === "ภาษาอังกฤษ"));
  assert.equal(records[2].examCode, "DEMO-1");
  assert.equal(records[2].choice.text, "2");
  assert.equal(records[2].correctness, "unverified");
  assert.equal(records[4].question.examCode, "DEMO-2");
  const beforeResync = readFileSync(first.structuredContent.historyFile, "utf8").trim().split("\n").map(JSON.parse).filter(r => r.type === "answer_requested").length;
  const resync = await client.callTool({ name: "answer_and_next", arguments: { examCode: "STALE", choiceIndex: 1, save: true } });
  assert.equal(resync.isError, undefined);
  assert.equal(resync.structuredContent.mode, "resync");
  assert.equal(resync.structuredContent.examCode, "DEMO-1");
  assert.equal(resync.structuredContent.answerApplied, false);
  assert.equal(readFileSync(first.structuredContent.historyFile, "utf8").trim().split("\n").map(JSON.parse).filter(r => r.type === "answer_requested").length, beforeResync);
  const review = await client.callTool({ name: "read_exam_result", arguments: {} });
  assert.equal(review.structuredContent.correctChoiceIndex, 2);
  assert.equal(review.content.filter((item) => item.type === "image").length, 1);
  assert.equal((await readCurrent()).structuredContent.verifiedAnswer.choiceIndex, 2);
  assert.equal((await answerAndNext()).structuredContent.verifiedAnswer.choiceIndex, 1);
  assert.equal((await client.callTool({ name: "open_answer_review", arguments: { resultToken: "review-token", step: "sheet" } })).structuredContent.action, "sheet");
  const jumped = await client.callTool({ name: "open_answer_review", arguments: { resultToken: "review-token", step: "question", questionNumber: 1 } });
  assert.equal(jumped.structuredContent.correctChoiceIndex, 2);
  const savedHistory = readFileSync(first.structuredContent.historyFile, "utf8");
  assert.ok(savedHistory.includes("combined navigation evidence"), "combined navigation must persist its returned explicit answer");
  await client.callTool({ name: "set_question_history", arguments: { enabled: false } });
  assert.equal((await readCurrent()).structuredContent.historyFile, undefined);
  assert.equal((await answerAndNext()).structuredContent.historyFile, undefined);
  assert.equal(readFileSync(first.structuredContent.historyFile, "utf8"), savedHistory);
  assert.equal((await client.callTool({ name: "advance_subject", arguments: {} })).structuredContent.mode, "overview");
  assert.equal((await client.callTool({ name: "complete_current_lesson", arguments: {} })).structuredContent.actions, 4);
  assert.equal((await client.callTool({ name: "submit_current_exam", arguments: { examCode: "DEMO-2" } })).structuredContent.mode, "submission");
  assert.equal((await client.callTool({ name: "set_exam_loop", arguments: { enabled: true } })).structuredContent.loopMode, "loop_until_50");
  assert.equal((await readCurrent()).structuredContent.verifiedAnswer.choiceIndex, 2);
  const stats = (await client.callTool({ name: "get_question_history_stats", arguments: {} })).structuredContent;
  assert.equal(stats.uniqueVerifiedQuestions, 2);
  assert.equal(stats.usableAnswers, 2);
  assert.equal(stats.verifiedRecords, 2, "repeat review must not duplicate canonical evidence");
  const beforeWrong = readFileSync(first.structuredContent.historyFile, "utf8");
  const wrongKnown = await client.callTool({ name: "answer_and_next", arguments: { examCode: "DEMO-1", choiceIndex: 1, save: true } });
  assert.equal(wrongKnown.structuredContent.mode, "verified_answer_available");
  assert.equal(wrongKnown.structuredContent.answerApplied, false);
  assert.equal(readFileSync(first.structuredContent.historyFile, "utf8"), beforeWrong);
  batchCursor = 0;
  const batch = await client.callTool({ name: "answer_known_questions", arguments: { maxQuestions: 20 } });
  assert.equal(batch.structuredContent.knownAnswersApplied, 2);
  assert.equal(batch.structuredContent.done, true);
  assert.equal(batch.structuredContent.batchStopReason, "exam_answered");
  assert.deepEqual(batchActions, [{ examCode: "DEMO-1", choiceIndex: 2, save: true }, { examCode: "DEMO-2", choiceIndex: 1, save: true }]);
  batchCursor = null;
  assert.equal((await client.callTool({ name: "set_exam_loop", arguments: { enabled: false } })).structuredContent.loopMode, "normal");
  await secondBridge.client.close();
  await stop();
  rmSync(historyDirectory, { recursive: true, force: true });
  await runVirtualTransport();
  console.log("prototype check passed: regression + Virtual review/history + two MCP tasks + images + site-specific batch transport");
};

const render = () => {
  console.clear();
  console.log("\x1b[1mINT Helper prototype\x1b[0m");
  console.log(`\x1b[1mbridge\x1b[0m: ${state.bridge}`);
  console.log(`\x1b[1mextension\x1b[0m: ${state.extension}`);
  console.log(`\x1b[1mlast action\x1b[0m: ${state.lastAction || "—"}`);
  console.log(`\x1b[1merror\x1b[0m: ${state.error || "—"}`);
  console.log("\x1b[1mcurrent question\x1b[0m:");
  console.log(JSON.stringify(state.current, null, 2));
  console.log("\n\x1b[1m[c]\x1b[0m connect  \x1b[1m[r]\x1b[0m read  \x1b[1m[a]\x1b[0m answer+next  \x1b[1m[d]\x1b[0m disconnect  \x1b[1m[q]\x1b[0m quit");
};

const interactive = async () => {
  await startBridge();
  await connectMockExtension();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  render();
  process.stdin.on("keypress", async (_input, key) => {
    try {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        await stop();
        process.exit(0);
      }
      if (key.name === "c") await connectMockExtension();
      if (key.name === "d") extensions.at(-1)?.close();
      if (key.name === "r") await readCurrent();
      if (key.name === "a") await answerAndNext();
    } catch (error) {
      state.error = error.message;
    }
    render();
  });
};

const main = async () => {
  if (process.argv.includes("--check")) await check();
  else await interactive();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
