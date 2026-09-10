import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createHistory } from "./history.mjs";
import { answerKnownQuestions } from "./known-answers.mjs";

let history = null;
let currentQuestion = null;
let historyScope = null;
const setHistoryScope = (scope) => {
  historyScope = scope;
  currentQuestion = null;
  if (history) history = createHistory(undefined, historyScope);
};
const rememberQuestion = (question, writer = history) => {
  if (!writer) return question;
  if (!question.questionText && !question.questionImage) return question;
  const { examCode, questionNumber, totalQuestions, questionText, questionImage, choices, images = [] } = question;
  const record = { examCode, questionNumber, totalQuestions, questionText, questionImage, choices, images };
  writer.append({ type: "question", scope: historyScope, question: record });
  currentQuestion = record;
  const match = writer.lookupDetailed(question);
  return { ...question, historyFile: writer.file, verifiedAnswer: match.answer, historyMatch: match.reason };
};

const basePort = Number(process.env.INT_PRACTICE_BRIDGE_PORT || 17373);
const portCount = 16;
const pending = new Map();
let browser = null;
let sequence = 0;

const rejectPending = (message) => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(message));
  }
  pending.clear();
};

const attachBridge = (bridge) => bridge.on("connection", (socket) => {
  setHistoryScope(null);
  browser?.close(1012, "A newer extension connection replaced this one");
  browser = socket;

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type !== "response" || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error || "Chrome extension request failed"));
  });

  socket.on("close", () => {
    if (browser === socket) browser = null;
    rejectPending("INT Practice Bridge extension disconnected");
  });
});

const listen = (port) =>
  new Promise((resolve, reject) => {
    const bridge = new WebSocketServer({
      host: "127.0.0.1",
      port,
      maxPayload: 16 * 1024 * 1024,
      // ponytail: origin-only pairing is enough for the local prototype; pin the extension ID before public distribution.
      verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("chrome-extension://"),
    });
    attachBridge(bridge);
    const onError = (error) => reject(error);
    bridge.once("error", onError);
    bridge.once("listening", () => {
      bridge.off("error", onError);
      resolve(bridge);
    });
  });

const startBridge = async () => {
  for (let port = basePort; port < basePort + portCount; port += 1) {
    try {
      const bridge = await listen(port);
      bridge.on("error", (error) => console.error(`INT Practice Bridge WebSocket error: ${error.message}`));
      return { bridge, port };
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No free INT Practice Bridge port in ${basePort}-${basePort + portCount - 1}`);
};

const requestBrowser = (action, payload = {}) =>
  new Promise((resolve, reject) => {
    if (!browser || browser.readyState !== browser.OPEN) {
      reject(new Error("INT Practice Bridge extension is not connected"));
      return;
    }
    const id = String(++sequence);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome extension timed out while running ${action}`));
    }, action === "complete_current_lesson" ? 90_000 : 15_000);
    pending.set(id, { resolve, reject, timer });
    browser.send(JSON.stringify({ type: "request", id, action, payload }));
  });

const toolResult = (question) => {
  const { images = [], ...data } = question;
  const content = [{ type: "text", text: JSON.stringify(data) }];
  for (const image of images) {
    content.push({
      type: "text",
      text: image.role === "question" ? "Question image" : `Answer choice ${image.choiceIndex} image`,
    });
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return { content, structuredContent: data };
};

const server = new McpServer({ name: "int-practice-bridge", version: "0.1.0" });

server.registerTool(
  "set_question_history",
  {
    description: "Enable or disable local question/answer history for this MCP session. OFF by default. Enable only when the user explicitly asks to save history. Changes affect subsequent calls; existing files are kept. No website action.",
    inputSchema: { enabled: z.boolean() },
    annotations: { destructiveHint: false },
  },
  async ({ enabled }) => {
    history = enabled ? history || createHistory(undefined, historyScope) : null;
    currentQuestion = null;
    return toolResult({ enabled, ...(history ? { historyFile: history.file } : {}) });
  },
);

server.registerTool(
  "read_current_question",
  {
    description: "Read the current question and images. Local history is OFF by default; records are saved only after explicit set_question_history activation. Does not change the website; may be used without automation scope.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async () => {
    const writer = history;
    return toolResult(rememberQuestion(await requestBrowser("read_current_question"), writer));
  },
);

server.registerTool(
  "inspect_page",
  {
    description: "Inspect the active supported page without clicking, answering, saving, or submitting. Use this before setting automation scope.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => toolResult(await requestBrowser("inspect_page")),
);

server.registerTool("read_subjects", {
  description: "Read INT subject cards on the selected level/term page: exact IDs, image labels, printed progress and listToken. Does not click. For an explicitly requested all-unfinished-subjects run, save the initial unfinished queue and listToken; Normal mode only.",
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => toolResult(await requestBrowser("read_subjects")));
server.registerTool("open_subject", {
  description: "Open one unfinished INT subject from the exact listToken returned by read_subjects in this session. Pins the listed tab; refuses changed lists, finished cards and unknown progress. Inspect the resulting overview and set normal subject scope before working. Never answers or submits.",
  inputSchema: { listToken: z.string().min(1), subjectCode: z.string().min(1) }, annotations: { destructiveHint: false },
}, async (payload) => { const result = await requestBrowser("open_subject", payload); setHistoryScope(null); return toolResult(result); });
server.registerTool("return_to_subjects", {
  description: "From the scoped INT subject overview, click its Select subject control and clear that course scope. First return from exams/results using normal scoped navigation. Read the list again and compare it with the original queue before opening the next unfinished subject.",
  inputSchema: {}, annotations: { destructiveHint: false },
}, async () => { const result = await requestBrowser("return_to_subjects"); setHistoryScope(null); return toolResult(result); });

server.registerTool(
  "set_scope",
  {
    description: "Set an explicit Virtual School or INT Project chapter/subject/final-only scope from the course overview, using its inspected subjectCode verbatim. retryUntilPerfect opts INT final-only scope into the 50-question review/retry loop and enables verified-answer history; default false is Normal and an explicit final-only request may retake a completed final once through its enabled link. This does not click the page.",
    inputSchema: {
      subjectCode: z.string().min(1),
      mode: z.enum(["chapter", "subject", "final"]),
      chapter: z.number().int().positive().optional(),
      allowEmptyPretest: z.boolean().default(false),
      retryUntilPerfect: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ subjectCode, mode, chapter, allowEmptyPretest, retryUntilPerfect }) => {
    const result = await requestBrowser("set_scope", { subjectCode, mode, chapter, allowEmptyPretest, retryUntilPerfect });
    setHistoryScope(result.scope || null);
    if (retryUntilPerfect) history ||= createHistory(undefined, historyScope);
    return toolResult(result);
  },
);

server.registerTool("set_exam_pacing", {
  description: "Set a minimum duration for each scoped INT 50-question final: 60 = one hour, 120 = two hours, 0 = off (default). Set after final scope and before entry. Each Loop retry gets its own duration. Changing the value uses the current attempt's original start. On mode=pacing, wait in interruptible chunks up to 60 seconds and retry the same action. Solving or website delays may make completion later. This tool does not sleep or run an exam.",
  inputSchema: { durationMinutes: z.number().min(0).max(720) }, annotations: { destructiveHint: false },
}, async (payload) => toolResult(await requestBrowser("set_exam_pacing", payload)));

server.registerTool(
  "set_exam_loop",
  { description: "Toggle the current scoped INT 50-question final between Normal (enabled=false: one attempt) and Loop (enabled=true: answer, submit, review and retry until a submitted 50/50). Preserves the current attempt. Enabling also enables local verified-answer history. Does not itself answer, submit, navigate, or run the model loop; follow the skill workflow.", inputSchema: { enabled: z.boolean() }, annotations: { destructiveHint: false } },
  async ({ enabled }) => {
    const result = await requestBrowser("set_exam_loop", { enabled });
    setHistoryScope(result.scope || null);
    if (enabled) history ||= createHistory(undefined, historyScope);
    return toolResult({ ...result, ...(history ? { historyFile: history.file } : {}) });
  },
);

server.registerTool(
  "set_current_exam_scope",
  {
    description: "When explicitly asked to work inside the already-open exam, pin that tab and page using examCode from read_current_question. No overview/course ID is required. Allows answering; set allowSubmit=true only when submission is authorized. Chapter navigation remains disabled. Reloading or leaving the page expires this scope.",
    inputSchema: { examCode: z.string().min(1), allowSubmit: z.boolean().default(false) },
    annotations: { destructiveHint: false },
  },
  async ({ examCode, allowSubmit }) => {
    const result = await requestBrowser("set_current_exam_scope", { examCode, allowSubmit });
    setHistoryScope(result.scope || null);
    return toolResult(result);
  },
);

const answerOne = async ({ choiceIndex, examCode, save }) => {
    const writer = history;
    if (!writer) return toolResult(await requestBrowser("answer_and_next", { choiceIndex, examCode, save }));
    if (currentQuestion?.examCode !== examCode) rememberQuestion(await requestBrowser("read_current_question"), writer);
    if (currentQuestion?.examCode !== examCode) return toolResult({ ...rememberQuestion(await requestBrowser("read_current_question"), writer),
      ok: true, mode: "resync", action: "question_refreshed", answerApplied: false, submissionApplied: false, done: false,
      nextAction: "answer_and_next", recovery: "Check this fresh question and use its exact examCode to continue. Do not reload." });
    const verified = historyScope?.retryUntilPerfect && writer.lookup(currentQuestion);
    if (verified && verified.choiceIndex !== choiceIndex) return toolResult({ ...currentQuestion, verifiedAnswer: verified,
      ok: true, mode: "verified_answer_available", answerApplied: false, done: false,
      recovery: "Use the exact verifiedAnswer for this question, or answer_known_questions. No answer was applied." });
    const choice = currentQuestion.choices.find((item) => item.index === choiceIndex);
    if (!choice) throw new Error("Answer choice not found");
    // Record intent before acting; this is not evidence of correctness or persistence.
    writer.append({ type: "answer_requested", examCode, questionNumber: currentQuestion.questionNumber, choice, saveRequested: save, correctness: "unverified" });
    const result = await requestBrowser("answer_and_next", { choiceIndex, examCode, save });
    if (result.mode === "pacing") return toolResult({ ...result, historyFile: writer.file });
    if (result.mode === "resync") return toolResult(rememberQuestion(result, writer));
    try {
      writer.append({ type: "answer_returned", examCode, selected: result.selected, saved: result.saved ?? null, correctness: "unverified" });
      const next = !result.done ? rememberQuestion(result, writer) : result;
      return toolResult({ ...next, historyFile: writer.file });
    } catch (error) {
      // The browser already acted: preserve its response so callers do not retry it.
      currentQuestion = null;
      return toolResult({ ...result, historyFile: writer.file, historyWarning: `Local history write failed: ${error.message}` });
    }
  };

server.registerTool(
  "answer_and_next",
  {
    description: "Within configured scope, answer and return the next question. INT Project requires save=true and its Save button advances automatically; Virtual School uses save=false. At done=true stop answering, including when INT wraps to question 1. mode=resync means nothing was applied: check the returned fresh question and continue with its exact examCode without reloading. Never submits an exam.",
    inputSchema: {
      choiceIndex: z.number().int().min(1).max(10),
      examCode: z.string().min(1),
      save: z.boolean().default(false),
    },
  },
  answerOne,
);

server.registerTool("answer_known_questions", {
  description: "Save up to 20 consecutive answers in the already authorized INT exam, using only exact verified local history matches. Never guesses or submits. Requires enabled history and scope. Stops at an unknown question, pacing, resync, done=true, or 12 seconds; returns the current question for reasoning. Use this to avoid re-solving known questions. Continue calling within the authorized loop when batchStopReason=batch_limit.",
  inputSchema: { maxQuestions: z.number().int().min(1).max(20).default(10) },
  annotations: { destructiveHint: false },
}, async ({ maxQuestions }) => {
  if (!history || !historyScope || !/^https:\/\/(?:www\.)?int-project\.com$/u.test(historyScope.origin || "")) throw new Error("Enable verified history in an INT scope first");
  const writer = history;
  const result = await answerKnownQuestions({ maxQuestions, stillAuthorized: () => history === writer,
    read: async () => rememberQuestion(await requestBrowser("read_current_question"), writer),
    answer: async payload => (await answerOne(payload)).structuredContent,
  });
  return toolResult(result);
});
server.registerTool("get_question_history_stats", {
  description: "Count actual saved history and rebuild its deduplicated answer-bank.json. Reports unique observed questions, unique verified questions, duplicate verification records and conflicts. Journals retain per-attempt evidence. Requires enabled subject-scoped history; never estimates unique counts from attempts × 50. No website action.",
  inputSchema: {}, annotations: { destructiveHint: false },
}, async () => {
  if (!history) throw new Error("Enable question history first");
  return toolResult(history.stats());
});

server.registerTool(
  "advance_subject",
  {
    description: "Within configured chapter or subject scope, take one lesson-navigation step. It never confirms or submits an exam submission.",
    inputSchema: {},
  },
  async () => toolResult(await requestBrowser("advance_subject")),
);

server.registerTool(
  "complete_current_lesson",
  {
    description: "Within configured chapter or explicitly configured whole-subject scope, run lesson navigation until an exam, chapter boundary, or completion. It never confirms or submits an exam submission.",
    inputSchema: {},
  },
  async () => toolResult(await requestBrowser("complete_current_lesson")),
);

server.registerTool(
  "submit_current_exam",
  {
    description: "Within configured scope, perform one guarded step of submitting the exact current exam. INT verifies saved answers through its answer sheet first. Use the examCode returned by each step. Known same-attempt codes can follow INT wrapping from question 50 to 1. mode=resync means nothing was submitted: retry with the returned current examCode in the same scope, without reloading. Inspect each returned action and repeat the required submission steps only for the authorized exam.",
    inputSchema: { examCode: z.string().min(1) },
  },
  async ({ examCode }) => toolResult(await requestBrowser("submit_current_exam", { examCode })),
);

const reviewToolResult = (response) => {
  const { verifiedReviews = [], rejectedReviews = [], ...result } = response;
  if (history && (result.verificationSource || result.score || verifiedReviews.length || rejectedReviews.length)) {
    try {
      for (const review of rejectedReviews) history.rejectAnswer(review);
      for (const review of verifiedReviews) history.rememberReview(review);
      if (result.verificationSource || result.score) history.rememberReview(result);
      return toolResult({ ...result, historyFile: history.file, historyStats: history.stats() });
    } catch (error) { return toolResult({ ...result, historyWarning: `Local history write failed: ${error.message}` }); }
  }
  return toolResult({ ...result, ...(history ? { historyFile: history.file } : {}) });
};
server.registerTool(
  "read_exam_result",
  { description: "Read submitted result or review without navigation. Saves verified green sheet rows and explicit corrected answers when history is enabled. reviewPlan reports greenCount, redCount, verifiedCount, remainingCount and nextQuestionNumber.", inputSchema: {}, annotations: { destructiveHint: false } },
  async () => reviewToolResult(await requestBrowser("read_exam_result")),
);
server.registerTool(
  "open_answer_review",
  { description: "Navigate from the latest exact resultToken AND return/save the destination review in one call. Default readAfter=true: step=open enters review; sheet reads all red/green rows; question jumps directly to questionNumber, opening the sheet internally if needed. Use returned reviewPlan.nextQuestionNumber until done. No extra read_exam_result is needed after success. close closes the sheet; return leaves review (no result read). readAfter=false is legacy navigation only. Never starts an attempt or submits.", inputSchema: { resultToken: z.string().min(1), step: z.enum(["open", "sheet", "close", "next", "question", "return"]).default("open"), questionNumber: z.number().int().min(1).max(50).optional(), readAfter: z.boolean().default(true) }, annotations: { destructiveHint: false } },
  async (payload) => reviewToolResult(await requestBrowser("open_answer_review", payload)),
);

const main = async () => {
  const { port } = await startBridge();
  console.error(`INT Practice Bridge listening on ws://127.0.0.1:${port}`);
  await server.connect(new StdioServerTransport());
};

main().catch((error) => {
  console.error(`INT Practice Bridge MCP error: ${error.message}`);
  process.exitCode = 1;
});
