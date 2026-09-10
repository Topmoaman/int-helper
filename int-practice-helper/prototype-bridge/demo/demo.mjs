import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
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

const createBridge = async (name) => {
  const bridgeTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.cjs"],
    cwd: root,
    env: { ...cleanEnv, INT_PRACTICE_BRIDGE_PORT: String(port), INT_PRACTICE_HISTORY_DIR: historyDirectory },
    stderr: "pipe",
  });
  const bridgeClient = new Client({ name, version: "0.1.0" });
  await bridgeClient.connect(bridgeTransport);
  return { client: bridgeClient, transport: bridgeTransport };
};

const startBridge = async () => {
  ({ client, transport } = await createBridge("int-practice-bridge-demo"));
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
    extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
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

const check = async () => {
  execFileSync(process.execPath, ["test/regression.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/review-fast.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/resync.mjs"], { stdio: "inherit" });
  execFileSync(process.execPath, ["test/bank-batch.mjs"], { stdio: "inherit" });
  const firstBridge = await createBridge("int-practice-bridge-demo-1");
  const secondBridge = await createBridge("int-practice-bridge-demo-2");
  ({ client, transport } = firstBridge);
  await connectMockExtension(port);
  try {
    await connectMockExtension(port + 1);
  } catch {
    // Expected before the multi-task port fallback fix.
  }
  const listed = await client.listTools();
  for (const name of ["set_scope", "read_subjects", "open_subject", "return_to_subjects", "set_exam_pacing", "answer_known_questions", "get_question_history_stats"]) assert.ok(listed.tools.find(tool => tool.name === name));
  assert.equal((await client.callTool({ name: "set_exam_pacing", arguments: { durationMinutes: -1 } })).isError, true);
  assert.equal((await client.callTool({ name: "open_subject", arguments: { subjectCode: "MATH" } })).isError, true);
  assert.deepEqual(listed.tools.find((tool) => tool.name === "set_current_exam_scope").inputSchema.required, ["examCode"]);
  assert.deepEqual(listed.tools.find((tool) => tool.name === "submit_current_exam").inputSchema.required, ["examCode"]);
  assert.equal((await client.callTool({ name: "submit_current_exam", arguments: {} })).isError, true);
  assert.equal((await readCurrent()).structuredContent.historyFile, undefined);
  await answerAndNext();
  assert.deepEqual(readdirSync(historyDirectory), []);
  assert.equal((await client.callTool({ name: "answer_known_questions", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "get_question_history_stats", arguments: {} })).isError, true);
  await client.callTool({ name: "set_scope", arguments: { subjectCode: "ENG", mode: "final" } });
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
  console.log("prototype check passed: regression + two MCP tasks + images + tool transport");
};

const render = () => {
  console.clear();
  console.log("\x1b[1mINT Practice Bridge prototype\x1b[0m");
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
