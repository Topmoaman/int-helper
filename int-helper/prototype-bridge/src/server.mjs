import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createHistory } from "./history.mjs";
import { answerKnownQuestions } from "./known-answers.mjs";
import { createUpdater } from "./updater.mjs";

const updater = createUpdater();
let updateInFlight = false;

let history = null;
let currentQuestion = null;
let historyScope = null;
const isIntOrigin = (origin) => /^https:\/\/(?:www\.)?int-project\.com$/u.test(String(origin || ""));
const isVirtualOrigin = (origin) => String(origin || "") === "https://main.virtualschool.club";
const historyScopeKey = (scope) => {
  if (!scope || (!isIntOrigin(scope.origin) && !isVirtualOrigin(scope.origin))) return null;
  const keys = isVirtualOrigin(scope.origin)
    ? ["origin", "subjectCode", "level", "term", "year"]
    : ["origin", "subjectCode", "subjectName", "level", "term", "year"];
  const values = keys.map((key) => String(scope[key] ?? "").normalize("NFC").replace(/\s+/gu, " ").trim());
  return values.every(Boolean) ? JSON.stringify(values) : null;
};
const captureHistoryContext = () => ({ writer: history, scope: historyScope, key: historyScopeKey(historyScope) });
const historyContextStillValid = (context) => context?.writer === history && context?.scope === historyScope && historyScopeKey(historyScope) === context.key;
const historyWarning = (question, details = {}) => ({
  ...question,
  ...details,
  historyWarning: "The browser action completed, but local history was not saved because the history writer or scoped course changed during the browser request",
});
const reviewContextStillValid = (context, response) => {
  if (!context?.writer || !historyContextStillValid(context) || !context.key) return false;
  // New worker responses bind review evidence to the scoped course. Keep
  // compatibility with older INT responses that omitted scope, while requiring
  // Virtual's newer adapter to return its binding explicitly.
  if (Object.prototype.hasOwnProperty.call(response || {}, "scope") && historyScopeKey(response.scope) !== context.key) return false;
  if (!Object.prototype.hasOwnProperty.call(response || {}, "scope") && !isIntOrigin(context.scope?.origin)) return false;
  for (const review of [...(response?.verifiedReviews || []), ...(response?.rejectedReviews || [])]) {
    if (Object.prototype.hasOwnProperty.call(review || {}, "scope") && historyScopeKey(review.scope) !== context.key) return false;
  }
  return true;
};
const setHistoryScope = (scope) => {
  historyScope = scope;
  currentQuestion = null;
  if (history) history = createHistory(undefined, historyScope);
};
const rememberQuestion = (question, writer = history, scope = historyScope) => {
  if (!writer) return question;
  if (!question.questionText && !question.questionImage) return question;
  const { examCode, questionNumber, totalQuestions, questionText, questionImage, choices, images = [] } = question;
  const record = { examCode, questionNumber, totalQuestions, questionText, questionImage, choices, images };
  writer.append({ type: "question", scope, question: record });
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

  socket.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", updaterProtocol: 1 }));
      return;
    }
    if (message.type === "update_request") {
      const reply = result => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "update_response", id: message.id, ...result })); };
      let ownsUpdate = false;
      try {
        await updater.authenticate(message.token);
        if (socket !== browser || message.action !== "install") throw new Error("Unsupported update request");
        if (updateInFlight || pending.size) throw new Error("An action is still running; finish it before updating");
        updateInFlight = true; ownsUpdate = true;
        const ensureIdle = async () => {
          if (socket !== browser || socket.readyState !== socket.OPEN || pending.size) throw new Error("Update connection changed or an action is still running");
          const guard = await requestBrowser("update_guard");
          if (!guard.safe) throw new Error("Finish the current task and leave the exam page before updating");
        };
        const result = await updater.installLatest({ ensureIdle });
        reply({ ok: true, result });
      } catch (error) { reply({ ok: false, error: error.message }); }
      finally { if (ownsUpdate) updateInFlight = false; }
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
    rejectPending("INT Helper extension disconnected");
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
      bridge.on("error", (error) => console.error(`INT Helper WebSocket error: ${error.message}`));
      return { bridge, port };
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No free INT Helper port in ${basePort}-${basePort + portCount - 1}`);
};

const requestBrowser = (action, payload = {}) =>
  new Promise((resolve, reject) => {
    if (updateInFlight && action !== "update_guard") {
      reject(new Error("INT Helper is updating; open a new task after it finishes"));
      return;
    }
    if (!browser || browser.readyState !== browser.OPEN) {
      reject(new Error("INT Helper extension is not connected"));
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

const server = new McpServer({ name: "int-helper-bridge", version: "0.1.0" });

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
    const context = captureHistoryContext();
    const question = await requestBrowser("read_current_question");
    if (!context.writer) return toolResult(question);
    if (!historyContextStillValid(context)) return toolResult(historyWarning(question));
    return toolResult(rememberQuestion(question, context.writer, context.scope));
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
  description: "Read supported subject cards on the selected level/term page: INT subjectCode or Virtual School cardToken, image labels, printed progress and listToken. Does not click. For an explicitly requested all-unfinished-subjects run, save the initial unfinished queue and listToken; Normal mode only.",
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => toolResult(await requestBrowser("read_subjects")));
server.registerTool("open_subject", {
  description: "Open one unfinished subject from the exact listToken returned by read_subjects in this session. INT uses subjectCode; Virtual School uses cardToken. Provide exactly one selector. Pins the listed tab; refuses changed lists, finished cards and unknown progress. Inspect the resulting overview and set normal subject scope before working. Never answers or submits.",
  inputSchema: z.object({
    listToken: z.string().min(1),
    subjectCode: z.string().min(1).optional(),
    cardToken: z.string().min(1).optional(),
  }).refine(({ subjectCode, cardToken }) => Boolean(subjectCode) !== Boolean(cardToken), {
    message: "Provide exactly one of subjectCode (INT) or cardToken (Virtual School)",
  }), annotations: { destructiveHint: false },
}, async (payload) => {
  const result = await requestBrowser("open_subject", payload);
  if (!result.navigationPending) setHistoryScope(null);
  return toolResult(result);
});
server.registerTool("return_to_subjects", {
  description: "From the scoped subject overview, click its Select subject control and clear that course scope after the destination is verified. First return from exams/results using normal scoped navigation. If navigationPending is returned, keep the current scope and inspect the destination before retrying. Read the list again and compare it with the original queue before opening the next unfinished subject.",
  inputSchema: {}, annotations: { destructiveHint: false },
}, async () => {
  const result = await requestBrowser("return_to_subjects");
  if (!result.navigationPending) setHistoryScope(null);
  return toolResult(result);
});

server.registerTool(
  "set_scope",
  {
    description: "Set an explicit Virtual School or INT Project chapter/subject/final-only scope from the course overview, using its inspected subjectCode verbatim. retryUntilPerfect opts a supported final scope into its review/retry workflow and enables verified-answer history; default false is Normal and an explicit final-only request may retake a completed final once through its enabled link. For Normal, ask once before starting whether to submit the whole exam after all answers are complete, unless the user already specified their choice. Carry that choice across the requested subjects: autoSubmit=true permits guarded whole-exam submission; false (default) leaves it to the user. Per-question saving is unaffected. Loop submission is authorized by its explicit loop request. The supported exam total comes from the observed page. This does not click the page.",
    inputSchema: {
      subjectCode: z.string().min(1),
      mode: z.enum(["chapter", "subject", "final"]),
      chapter: z.number().int().positive().optional(),
      allowEmptyPretest: z.boolean().default(false),
      retryUntilPerfect: z.boolean().default(false),
      autoSubmit: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ subjectCode, mode, chapter, allowEmptyPretest, retryUntilPerfect, autoSubmit }) => {
    const result = await requestBrowser("set_scope", { subjectCode, mode, chapter, allowEmptyPretest, retryUntilPerfect, autoSubmit });
    setHistoryScope(result.scope || null);
    if (retryUntilPerfect) history ||= createHistory(undefined, historyScope);
    return toolResult(result);
  },
);

server.registerTool("set_exam_pacing", {
  description: "Set a target duration in minutes for a supported scoped final. 0 disables pacing; up to 119 minutes reserves one minute before the 120-minute exam limit. Set after final scope and before entry. Space answers across the chosen duration so the last answer targets that time, in both automatic and manual submission modes; first answer can be immediate. INT requires 50 questions; Virtual uses its observed total. Each retry starts a fresh clock; changing the duration keeps the original attempt start. On mode=pacing, wait until waitUntil in interruptible chunks of at most 60 seconds and retry the same action. Elapsed slots add no extra wait. Website or reasoning delays can overrun the target; exact wall-clock completion is not guaranteed. Does not itself sleep or run an exam.",
  inputSchema: { durationMinutes: z.number().min(0).max(119) }, annotations: { destructiveHint: false },
}, async (payload) => toolResult(await requestBrowser("set_exam_pacing", payload)));

server.registerTool(
  "set_exam_loop",
  { description: "Toggle the current scoped supported final between Normal (enabled=false: one attempt) and Loop (enabled=true: answer, submit, review and retry until the observed total is fully correct). INT retains its 50-question rule; Virtual School uses its observed total and explicit review evidence. Preserves the current attempt. Enabling also enables local verified-answer history. Does not itself answer, submit, navigate, or run the model loop; follow the skill workflow.", inputSchema: { enabled: z.boolean() }, annotations: { destructiveHint: false } },
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
    const context = captureHistoryContext();
    const writer = context.writer;
    if (!writer) return toolResult(await requestBrowser("answer_and_next", { choiceIndex, examCode, save }));
    let refreshed;
    if (currentQuestion?.examCode !== examCode) {
      const question = await requestBrowser("read_current_question");
      if (!historyContextStillValid(context)) return toolResult(historyWarning(question, { answerApplied: false, submissionApplied: false }));
      refreshed = rememberQuestion(question, writer, context.scope);
    }
    if (currentQuestion?.examCode !== examCode) return toolResult({ ...refreshed,
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
    if (!historyContextStillValid(context)) return toolResult(historyWarning(result));
    if (result.mode === "pacing") return toolResult({ ...result, historyFile: writer.file });
    if (result.mode === "resync") return toolResult(rememberQuestion(result, writer, context.scope));
    try {
      writer.append({ type: "answer_returned", examCode, selected: result.selected, saved: result.saved ?? null, correctness: "unverified" });
      const next = !result.done ? rememberQuestion(result, writer, context.scope) : result;
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
  description: "Answer up to 20 consecutive questions in an already authorized INT or Virtual School exam, using only exact verified local history matches. INT receives save=true; Virtual School receives save=false. Never guesses or submits. Requires enabled, identified history and supported scope. Stops at an unknown question, pacing, resync, done=true, or 12 seconds; returns the current question for reasoning. Continue calling within the authorized loop when batchStopReason=batch_limit.",
  inputSchema: { maxQuestions: z.number().int().min(1).max(20).default(10) },
  annotations: { destructiveHint: false },
}, async ({ maxQuestions }) => {
  const scopeKey = historyScopeKey(historyScope);
  if (!history || !scopeKey) throw new Error("Enable verified history in an identified INT or Virtual School scope first");
  const writer = history;
  const result = await answerKnownQuestions({ maxQuestions, save: isIntOrigin(historyScope.origin),
    stillAuthorized: () => history === writer && historyScopeKey(historyScope) === scopeKey,
    read: async () => {
      const context = captureHistoryContext();
      const question = await requestBrowser("read_current_question");
      if (!context.writer) return question;
      if (!historyContextStillValid(context)) return historyWarning(question);
      return rememberQuestion(question, context.writer, context.scope);
    },
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
    description: "Within configured scope, perform one guarded step of submitting the whole exact current exam for grading. Normal course scopes require autoSubmit=true; otherwise returns awaiting_user_submission without clicking. This setting does not block per-question Save. INT verifies saved answers through its answer sheet first; Virtual School uses its scoped answer ledger and known confirmation. Use the examCode returned by each step. Same-attempt codes can follow the site's final-question behavior. mode=resync means nothing was submitted: retry with the returned current examCode in the same scope, without reloading. Inspect each returned action and repeat the required submission steps only for the authorized exam.",
    inputSchema: { examCode: z.string().min(1) },
  },
  async ({ examCode }) => toolResult(await requestBrowser("submit_current_exam", { examCode })),
);

const reviewToolResult = (response, context = captureHistoryContext()) => {
  const { verifiedReviews = [], rejectedReviews = [], ...result } = response;
  const hasEvidence = result.verificationSource || result.score || verifiedReviews.length || rejectedReviews.length;
  const virtualEvidencePending = isVirtualOrigin(context.scope?.origin) && hasEvidence && response.reviewBound !== true;
  if (virtualEvidencePending) {
    const pending = { ...result, evidencePending: true, historyVerificationPending: true };
    if (history && reviewContextStillValid(context, response)) pending.historyFile = context.writer.file;
    else if (history) pending.historyWarning = "Virtual review evidence is pending a bound complete review for this submitted attempt";
    return toolResult(pending);
  }
  if (hasEvidence && reviewContextStillValid(context, response)) {
    try {
      for (const review of rejectedReviews) context.writer.rejectAnswer(review);
      for (const review of verifiedReviews) context.writer.rememberReview(review);
      if (result.verificationSource || result.score) context.writer.rememberReview(result);
      return toolResult({ ...result, historyFile: context.writer.file, historyStats: context.writer.stats() });
    } catch (error) { return toolResult({ ...result, historyWarning: `Local history write failed: ${error.message}` }); }
  }
  if (hasEvidence && history) {
    return toolResult({ ...result, historyWarning: "Review evidence was not saved because the history writer or scoped course changed during the browser read" });
  }
  return toolResult({ ...result, ...(history ? { historyFile: history.file } : {}) });
};
server.registerTool(
  "read_exam_result",
  { description: "Read the submitted result or review without navigation. When history is enabled, saves only site-explicit verified answers and bound selected-answer corrections for the scoped course. Virtual School accepts only its explicit correct-answer label; an aggregate score alone is never a bank answer. reviewPlan reports observed green/red/verified/remaining counts and the next question number.", inputSchema: {}, annotations: { destructiveHint: false } },
  async () => {
    const context = captureHistoryContext();
    return reviewToolResult(await requestBrowser("read_exam_result"), context);
  },
);
server.registerTool(
  "open_answer_review",
  { description: "Navigate from the latest exact resultToken and return/save the destination review in one call. Default readAfter=true: on Virtual School, step=open enters review AND automatically opens ดูเฉลยทุกข้อในชุดนี้, reading and saving all explicit answers in one call. Do not walk Virtual questions with next; if already on a single review use sheet once. On INT, open enters the single review and sheet reads its green/red answer sheet; question jumps directly to questionNumber, opening the sheet internally if needed. Use returned reviewPlan.nextQuestionNumber until done. The question bound is 1–1000; the active worker may apply a smaller site-specific bound. No extra read_exam_result is needed after success. close closes the sheet; return leaves review (no result read). readAfter=false is legacy navigation only. Never starts an attempt or submits.", inputSchema: { resultToken: z.string().min(1), step: z.enum(["open", "sheet", "close", "next", "question", "return"]).default("open"), questionNumber: z.number().int().min(1).max(1000).optional(), readAfter: z.boolean().default(true) }, annotations: { destructiveHint: false } },
  async (payload) => {
    const context = captureHistoryContext();
    return reviewToolResult(await requestBrowser("open_answer_review", payload), context);
  },
);

const main = async () => {
  const { bridge, port } = await startBridge();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    rejectPending("INT Helper MCP connection closed");
    // The WebSocket listener otherwise keeps Node alive after Codex closes its
    // stdio pipe. Stop accepting connections and release every browser socket.
    const closed = new Promise(resolve => bridge.close(resolve));
    for (const client of bridge.clients) client.terminate();
    try { await server.close(); } finally { await closed; }
  };
  const requestShutdown = () => { void shutdown().catch(error => {
    console.error(`INT Helper shutdown error: ${error.message}`);
    process.exitCode = 1;
  }); };
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  server.server.onclose = requestShutdown;
  console.error(`INT Helper listening on ws://127.0.0.1:${port}`);
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await shutdown(); throw error; }
  if (process.stdin.readableEnded || process.stdin.destroyed) await shutdown();
};

main().catch((error) => {
  console.error(`INT Helper MCP error: ${error.message}`);
  process.exitCode = 1;
});
