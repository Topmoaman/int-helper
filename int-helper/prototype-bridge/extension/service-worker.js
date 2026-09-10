const BRIDGE_PORTS = Array.from({ length: 16 }, (_, index) => 17373 + index);
const SUBJECT_URLS = [
  "https://int-project.com/student/virtual_school/*",
  "https://www.int-project.com/student/virtual_school/*",
  "https://main.virtualschool.club/*",
];
const sockets = new Map();
const reconnectTimers = new Map();
const heartbeats = new Map();
const sessions = new Map();
const subjectLists = new Map();
// ponytail: one mutation at a time across tabs; use per-tab locks if parallel courses are needed.
let mutationInFlight = false;
if (typeof importScripts === "function") importScripts("updates.js");
const helperUpdates = globalThis.createHelperUpdates?.({
  chrome, sockets, connectedPorts: () => connectedPorts(),
  isBusy: () => mutationInFlight || [...sessions.values()].some(session => !session.completed),
  onChange: () => updateBadge(),
});
const connectedPorts = () => [...sockets].filter(([port, socket]) =>
  socket.readyState === WebSocket.OPEN && Date.now() - (heartbeats.get(port) || 0) < 45_000,
).map(([port]) => port);
const updateBadge = () => {
  const connected = connectedPorts().length > 0;
  chrome.action.setBadgeText({ text: helperUpdates?.available ? "UP" : connected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#16734A" : "#656C78" });
  chrome.action.setTitle({ title: connected ? "INT Helper connected — click for page status" : "INT Helper disconnected — open a Codex task with INT Helper" });
};

const getStatus = async () => {
  const status = { ports: connectedPorts(), version: chrome.runtime.getManifest().version, page: "unsupported",
    update: typeof helperUpdates === "undefined" ? undefined : await helperUpdates?.status() };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(?:(?:www\.)?int-project\.com\/student\/virtual_school(?:\/|$)|main\.virtualschool\.club(?:\/|$))/u.test(tab.url || "")) return status;
  const live = [...sessions.entries()].filter(([port]) => status.ports.includes(port));
  status.scopes = live.filter(([, session]) => session.tabId === tab.id)
    .map(([port, session]) => ({ port, ...session.scope }));
  status.otherScopedTabs = new Set(live.filter(([, session]) => session.tabId !== tab.id).map(([, session]) => session.tabId)).size;
  // Status never injects scripts or navigates: a missing receiver needs a page reload.
  let timer;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { action: "page_version" }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Page check timed out")), 1500); }),
    ]);
    status.pageVersion = response?.result?.contentVersion || null;
    status.page = response?.ok && status.pageVersion === status.version ? "ready" : "reload";
  } catch {
    status.page = "reload";
  } finally {
    clearTimeout(timer);
  }
  return status;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "bridge_status" && sender.url === chrome.runtime.getURL("popup.html")) {
    getStatus().then(sendResponse, () => sendResponse({ error: "Could not check status. Reopen this popup." }));
    return true;
  }
  if (message.action !== "keep_bridge_awake") return;
});

const connect = (port) => {
  clearTimeout(reconnectTimers.get(port));
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.set(port, socket);
  socket.onopen = () => socket.send(JSON.stringify({ type: "ping" }));
  socket.onmessage = async ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    helperUpdates?.receive(port, message);
    if (message.type === "pong") {
      heartbeats.set(port, Date.now());
      updateBadge();
      return;
    }
    if (message.type !== "request") return;
    try {
      const result = await handleRequest(message.action, message.payload || {}, port);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "response", id: message.id, ok: false, error: error.message }));
      }
    }
  };
  socket.onclose = () => {
    if (sockets.get(port) === socket) {
      sockets.delete(port);
      heartbeats.delete(port);
    }
    sessions.delete(port);
    subjectLists.delete(port);
    updateBadge();
    reconnectTimers.set(port, setTimeout(() => connect(port), 1_000));
  };
  socket.onerror = () => socket.close();
};

setInterval(() => {
  updateBadge();
  for (const socket of sockets.values()) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }
}, 20_000);

const findTab = async (urls, error) => {
  const tabs = await chrome.tabs.query({ url: urls });
  const tab = tabs.find((candidate) => candidate.active) || tabs[0];
  if (!tab?.id) throw new Error(error);
  return tab;
};

const sendToPage = async (tabId, message) => {
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch {
    throw new Error("Practice page needs reloading before it can be used");
  }
  if (!response?.ok) throw new Error(response?.error || "INT page did not respond");
  return response.result;
};

const requireCurrentPage = async (tabId) => {
  const page = await sendToPage(tabId, { action: "page_version" });
  if (page.contentVersion !== chrome.runtime.getManifest().version) {
    throw new Error("Practice page needs reloading before it can be used");
  }
};

const sendScoped = async (session, message) => {
  const ensureSession = () => {
    if (sessions.get(session.port) !== session) throw new Error("Scope expired; set it again before continuing");
  };
  ensureSession();
  await requireCurrentPage(session.tabId);
  ensureSession();
  const result = await sendToPage(session.tabId, { ...message, scope: session.scope });
  ensureSession();
  if (message.action === "advance_subject" && result.intActivity) {
    if (result.intActivity.enteredAt && result.intActivity.enteredAt !== session.scope.intActivity?.enteredAt) {
      session.attemptAnswers = new Map();
      session.submitted = false;
      session.reviewSheet = null;
      session.rejectedQuestions = new Set();
    }
    session.scope = { ...session.scope, intActivity: result.intActivity };
  }
  return result;
};

const configuredSession = (port) => {
  const session = sessions.get(port);
  if (!session) throw new Error("Set automation scope before changing a practice page");
  return session;
};

const inspectActivePage = async () => {
  const tab = await findTab(SUBJECT_URLS, "Open a supported signed-in practice page in Chrome");
  await requireCurrentPage(tab.id);
  return { tab, page: await sendToPage(tab.id, { action: "inspect_page" }) };
};

const inspectPage = async () => (await inspectActivePage()).page;

const setCurrentExamScope = async (port, { examCode, allowSubmit }) => {
  if (mutationInFlight) throw new Error("Cannot change scope during a running action");
  if (typeof examCode !== "string" || !examCode) throw new Error("Read the current question to obtain examCode first");
  const { tab } = await inspectActivePage();
  const scope = await sendToPage(tab.id, { action: "bind_current_exam", expectedExamCode: examCode, examBinding: crypto.randomUUID(), allowSubmit: allowSubmit === true });
  sessions.set(port, { scope, tabId: tab.id, port });
  return { scope, tabId: tab.id };
};

const setScope = async (port, { subjectCode, mode, chapter, allowEmptyPretest, retryUntilPerfect }) => {
  if (mutationInFlight) throw new Error("Cannot change scope during a running action");
  if (!["chapter", "subject", "final"].includes(mode) || (mode === "chapter" && (!Number.isInteger(chapter) || chapter < 1))) throw new Error("Invalid scope");
  const { tab, page } = await inspectActivePage();
  const int = /^https:\/\/(?:www\.)?int-project\.com$/u.test(page.origin);
  if (retryUntilPerfect && (!int || mode !== "final")) throw new Error("Perfect-score looping requires INT final-only scope");
  if (mode === "final" && !int && !/^\/StudyCourse\/?$/iu.test(page.path)) throw new Error("Set final scope from the course overview");
  if (!int && page.origin !== "https://main.virtualschool.club") throw new Error("Unsupported practice origin");
  if (int && !/^\/student\/virtual_school\/(?:index\.php)?$/u.test(page.path)) {
    throw new Error("Set INT scope from the course overview before entering activities");
  }
  const course = page.course;
  if (!course || course.subjectCode !== subjectCode || !course.level || !course.term || !course.year || (int && !course.subjectName)) {
    throw new Error("The active page does not provide the requested complete course metadata");
  }
  let chapterTitle;
  if (mode === "chapter") {
    if (!chapter) throw new Error("Chapter scope requires a chapter number");
    const matches = (page.chapters || []).filter((candidate) => candidate.number === chapter);
    if (matches.length !== 1 || !matches[0].title) throw new Error("The requested chapter is not uniquely identified on this page");
    chapterTitle = matches[0].title;
    if ((page.chapters || []).filter((candidate) => candidate.title === chapterTitle).length !== 1) {
      throw new Error("The requested chapter title is not unique on this page");
    }
  }
  const scope = { ...course, origin: page.origin, mode, chapter, chapterTitle, allowEmptyPretest, retryUntilPerfect: retryUntilPerfect === true };
  sessions.set(port, { scope, tabId: tab.id, port });
  return { scope, tabId: tab.id };
};

const bytesToBase64 = (bytes) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const fetchImage = async (url, role, choiceIndex) => {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Image request failed (${response.status}): ${url}`);
  return {
    role,
    choiceIndex,
    mimeType: response.headers.get("content-type") || "image/jpeg",
    data: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
  };
};

const hydrateImages = async (question) => {
  const jobs = [];
  if (question.questionImage) jobs.push(fetchImage(question.questionImage, "question"));
  for (const choice of question.choices) {
    if (choice.image) jobs.push(fetchImage(choice.image, "choice", choice.index));
  }
  return { ...question, images: await Promise.all(jobs) };
};

const readCurrent = async (port) => {
  const session = sessions.get(port);
  const tab = session ? { id: session.tabId } : await findTab(SUBJECT_URLS, "Open a supported signed-in practice page in Chrome");
  await requireCurrentPage(tab.id);
  return hydrateImages(await (session ? sendScoped(session, { action: "read_question" }) : sendToPage(tab.id, { action: "read_question" })));
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const navigateNext = async (session, examCode) => {
  let navigation;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    navigation = await sendScoped(session, { action: "navigate_next", expectedExamCode: examCode });
    if (!navigation.done) return navigation;
    await delay(100);
  }
  return navigation;
};

const waitForNext = async (session, previousExamCode, allowSame = false) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(150);
    try {
      const question = await sendScoped(session, { action: "read_question" });
      if (!question.saving && (question.examCode !== previousExamCode || allowSame)) return hydrateImages(question);
    } catch (error) {
      if (/scope|reload|version/iu.test(error.message)) throw error;
      // Navigation can briefly unload the content script.
    }
  }
  throw new Error("Timed out waiting for the next question");
};

// Each final entry (including retries) supplies its own start timestamp.
const pacingWait = async (session, examCode, submitting = false) => {
  const minutes = session.scope.durationMinutes || 0;
  if (!minutes) return null;
  const question = await sendScoped(session, { action: "read_question" });
  if (question.examCode !== examCode) throw new Error("Stale exam code; read the current question again");
  if (question.totalQuestions !== 50 || !Number.isInteger(question.questionNumber) || question.questionNumber < 1 || question.questionNumber > 50) throw new Error("Timed pacing requires exactly 50 questions");
  const startedAt = session.scope.intActivity?.enteredAt;
  if (!Number.isFinite(startedAt)) throw new Error("Timed pacing requires entering the final through the scoped overview");
  const durationMs = minutes * 60_000;
  const dueAt = startedAt + durationMs * (submitting ? 1 : (question.questionNumber - 1) / 50);
  const waitMs = Math.max(0, Math.ceil(dueAt - Date.now()));
  return waitMs ? { ok: true, mode: "pacing", action: "waiting", answerApplied: false, done: false,
    examCode, questionNumber: question.questionNumber, waitMs, waitUntil: new Date(dueAt).toISOString(),
    submissionAt: new Date(startedAt + durationMs).toISOString() } : null;
};

const isStaleQuestion = (error) => /^(?:stale exam code:|Stale exam code;|Stale question before saving)/u.test(error.message);
const resyncQuestion = async (session, nextAction) => ({
  ...(await hydrateImages(await sendScoped(session, { action: "read_question" }))),
  ok: true, mode: "resync", action: "question_refreshed", answerApplied: false, submissionApplied: false,
  done: false, nextAction, recovery: "Use this fresh question and examCode to continue in the same scope. Do not reload or reuse an old choice without checking the question.",
});

const answerAndNext = async ({ choiceIndex, examCode, save }, port) => {
  const session = configuredSession(port);
  let waiting;
  try { waiting = await pacingWait(session, examCode); }
  catch (error) { if (isStaleQuestion(error)) return resyncQuestion(session, "answer_and_next"); throw error; }
  if (waiting) return waiting;
  const question = session.scope.retryUntilPerfect ? await sendScoped(session, { action: "read_question" }) : null;
  if (question && question.examCode !== examCode) return resyncQuestion(session, "answer_and_next");
  let selected;
  try { selected = await sendScoped(session, {
    action: "apply_answer",
    choiceIndex,
    expectedExamCode: examCode,
    save: save === true,
  }); } catch (error) { if (isStaleQuestion(error)) return resyncQuestion(session, "answer_and_next"); throw error; }
  if (question) {
    session.attemptAnswers ||= new Map();
    session.attemptAnswers.set(question.questionNumber, { ...question, selectedChoiceIndex: selected.selected });
  }
  const { examCode: answeredExamCode, ...selection } = selected;
  const answered = { ...selection, answeredExamCode };
  if (selected.autoAdvance) {
    const next = await waitForNext(session, examCode, selected.lastQuestion === true);
    return { ...next, ...answered, done: selected.lastQuestion === true };
  }
  const navigation = await navigateNext(session, examCode);
  if (navigation.done) return { ok: true, ...answered, examCode, done: true, images: [] };
  return { ...(await waitForNext(session, examCode)), ...answered };
};

const advanceSubject = async (port) => {
  return sendScoped(configuredSession(port), { action: "advance_subject" });
};

const completeCurrentLesson = async (port) => {
  const session = configuredSession(port);
  const trace = [];
  for (let actions = 1; actions <= 80; actions += 1) {
    let result;
    try {
      result = await sendScoped(session, { action: "advance_subject" });
    } catch (error) {
      // A returning overview can mount before its chapter cards. Never click until scope validates.
      if (error.message !== "Chapter overview is loading") throw error;
      result = { mode: "overview", action: "waiting" };
    }
    const step = JSON.stringify(result);
    if (trace.at(-1) !== step) {
      trace.push(step);
      if (trace.length > 8) trace.shift();
    }
    if (result.mode === "exam" || result.mode === "chapter_complete" || result.mode === "complete" || result.mode === "scope_boundary" || result.mode === "review_required") {
      return { ...result, actions };
    }
    if (result.mode === "submission" && result.action === "confirmation_required") {
      return { ...result, actions };
    }
    await delay(result.action === "waiting" ? 250 : 700);
  }
  const page = await sendScoped(session, { action: "inspect_page" })
    .catch((error) => ({ inspectionError: error.message }));
  throw new Error(`Stopped after the lesson action limit; trace=[${trace.join(",")}]; page=${JSON.stringify(page)}`);
};

const submitCurrentExam = async ({ examCode }, port) => {
  if (typeof examCode !== "string" || !examCode) throw new Error("An exact examCode is required for submission");
  const session = configuredSession(port);
  const current = await sendScoped(session, { action: "read_question" });
  let submittedCode = examCode;
  if (current.examCode !== examCode) {
    // Only bridge-issued question codes from this exact attempt can follow a final wrap.
    const anchor = session.attemptAnswers?.get(current.questionNumber);
    const knownPrevious = [...(session.attemptAnswers?.values() || [])].some(q => q.examCode === examCode);
    if (anchor?.examCode !== current.examCode || !knownPrevious) return resyncQuestion(session, "submit_current_exam");
    submittedCode = current.examCode;
  }
  let waiting, result;
  try {
    waiting = await pacingWait(session, submittedCode, true);
    if (waiting) return waiting;
    result = await sendScoped(session, { action: "submit_exam", expectedExamCode: submittedCode });
  } catch (error) { if (isStaleQuestion(error)) return resyncQuestion(session, "submit_current_exam"); throw error; }
  if (result.action === "confirmed") session.submitted = true;
  return { ...result, examCode: submittedCode, ...(submittedCode !== examCode ? { codeRefreshed: true } : {}) };
};

// Only join sheet row numbers to answers captured in this submitted attempt.
const selectiveReview = (session, result) => {
  const activity = session.scope.intActivity;
  const reviewed = new Set(activity.reviewedQuestions || []);
  const rows = result.sheet || [];
  const completeSheet = rows.length === 50 && new Set(rows.map(r => r.questionNumber)).size === 50 &&
    rows.every(r => Number.isInteger(r.questionNumber) && r.questionNumber >= 1 && r.questionNumber <= 50 &&
      ["correct", "incorrect"].includes(r.correctness) && Number.isInteger(r.selectedChoiceIndex) && r.selectedChoiceIndex >= 1 && r.selectedChoiceIndex <= 5);
  if (rows.length && !completeSheet) throw new Error("Review sheet is incomplete or has unknown answer markers");
  if (completeSheet && activity.finalResult && rows.filter(row => row.correctness === "correct").length !== activity.finalResult.correct) throw new Error("Review sheet does not match the submitted score");
  const verifiedReviews = [], rejectedReviews = [];
  if (completeSheet) {
    session.reviewSheet = rows;
    const anchor = session.attemptAnswers?.get(result.questionNumber);
    const sameAttempt = session.submitted && anchor?.examCode === result.examCode;
    for (const row of rows) {
      const saved = sameAttempt && session.attemptAnswers?.get(row.questionNumber);
      if (!saved || saved.selectedChoiceIndex !== row.selectedChoiceIndex || !saved.choices.some(c => c.index === row.selectedChoiceIndex)) continue;
      const evidence = { ...saved, url: result.url, correctness: row.correctness,
        verificationSource: "INT submitted answer-sheet marker", evidence: "Question " + row.questionNumber + ": " + row.correctness };
      if (row.correctness === "correct") {
        if (!reviewed.has(row.questionNumber)) verifiedReviews.push({ ...evidence, correctChoiceIndex: row.selectedChoiceIndex });
        reviewed.add(row.questionNumber);
      } else {
        session.rejectedQuestions ||= new Set();
        if (!session.rejectedQuestions.has(row.questionNumber)) rejectedReviews.push(evidence);
        session.rejectedQuestions.add(row.questionNumber);
      }
    }
  }
  reviewed.add(result.questionNumber);
  const sheet = session.reviewSheet;
  const pending = sheet ? sheet.filter(row => !reviewed.has(row.questionNumber)) : [];
  const needsReview = pending.filter(row => row.correctness === "incorrect").concat(pending.filter(row => row.correctness !== "incorrect")).map(row => row.questionNumber);
  session.scope = { ...session.scope, intActivity: { ...activity, reviewedQuestions: [...reviewed] } };
  return { ...result, verifiedReviews, rejectedReviews, reviewPlan: { sheetRead: !!sheet,
    verifiedCount: reviewed.size, needsReview, nextQuestionNumber: needsReview[0] || null,
    greenCount: sheet?.filter(row => row.correctness === "correct").length || 0,
    redCount: sheet?.filter(row => row.correctness === "incorrect").length || 0,
    remainingCount: needsReview.length, done: !!sheet && reviewed.size === 50 } };
};

const mutations = new Set(["answer_and_next", "advance_subject", "complete_current_lesson", "submit_current_exam"]);

// Keep navigation and its evidence read in one bounded request; never answer or submit here.
const readReviewResult = async (tabId, session) => {
  let result = await sendToPage(tabId, { action: "read_exam_result", ...(session?.scope.retryUntilPerfect ? { scope: session.scope } : {}) });
  if (session?.scope.intActivity?.examType === "F" && result.score) {
    session.scope = { ...session.scope, intActivity: { ...session.scope.intActivity, finalResult: result.score } };
  }
  if (session?.scope.retryUntilPerfect && result.verificationSource) {
    if (result.totalQuestions !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
    result = selectiveReview(session, result);
  }
  return { ...result, loopMode: session?.scope.retryUntilPerfect ? "loop_until_50" : "normal" };
};
const navigateReview = async (tabId, session, payload, assertSession = () => {}) => {
  assertSession();
  const navigate = (token) => { assertSession(); return sendToPage(tabId, { action: "open_answer_review", expectedResultToken: token, step: payload.step, questionNumber: payload.questionNumber }); };
  let navigation = await navigate(payload.resultToken);
  if (payload.readAfter === false || payload.step === "return" || navigation.done) return navigation;
  let needsJump = payload.step === "question" && navigation.action === "opened_sheet";
  const verified = [], rejected = [];
  let lastResult;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await delay(150);
    assertSession();
    let result;
    try { result = await readReviewResult(tabId, session); }
    catch (error) {
      if (/needs reloading|explicit correct answer is not ready|Open the submitted result/u.test(error.message)) continue;
      throw error;
    }
    assertSession();
    lastResult = result;
    verified.push(...(result.verifiedReviews || [])); rejected.push(...(result.rejectedReviews || []));
    if (needsJump) {
      if (!result.sheet?.length) continue;
      navigation = await navigate(result.resultToken);
      needsJump = false;
      continue;
    }
    const ready = payload.step === "question" ? result.questionNumber === payload.questionNumber && !result.sheet?.length
      : payload.step === "sheet" ? result.sheet?.length > 0
      : payload.step === "close" ? !result.sheet?.length
      : result.resultToken !== payload.resultToken;
    if (ready) return { ...result, verifiedReviews: verified, rejectedReviews: rejected, navigationAction: navigation.action };
  }
  if (lastResult) return { ...lastResult, verifiedReviews: verified, rejectedReviews: rejected, navigationPending: true,
    requestedQuestionNumber: payload.questionNumber || null, navigationWarning: "Navigation timed out. Read the current result before continuing; do not repeat submission." };
  throw new Error("Review navigation timed out; read_exam_result before continuing. Do not repeat submission.");
};

const handleRequest = async (action, payload, port) => {
  if (action === "update_guard") return { safe: !!helperUpdates?.busy && await helperUpdates.idle() };
  if (helperUpdates?.busy) throw new Error("INT Helper is updating; open a new task after it finishes");
  if (action === "read_exam_result" || action === "open_answer_review") {
    const session = sessions.get(port);
    const tab = session ? { id: session.tabId } : await findTab(SUBJECT_URLS, "Open the submitted result page");
    await requireCurrentPage(tab.id);
    if (action === "read_exam_result") {
      return hydrateImages(await readReviewResult(tab.id, session));
    }
    if (mutationInFlight) throw new Error("Another practice-page mutation is already running");
    mutationInFlight = true;
    try { return await hydrateImages(await navigateReview(tab.id, session, payload, () => { if (session && sessions.get(port) !== session) throw new Error("Scope expired; set it again before continuing"); })); }
    finally { mutationInFlight = false; }
  }
  if (action === "read_subjects") {
    const { tab } = await inspectActivePage();
    const result = await sendToPage(tab.id, { action });
    subjectLists.set(port, { tabId: tab.id, listToken: result.listToken });
    return result;
  }
  if (action === "open_subject" || action === "return_to_subjects") {
    if (mutationInFlight) throw new Error("Another practice-page mutation is already running");
    mutationInFlight = true;
    try {
      let result;
      if (action === "open_subject") {
        const list = subjectLists.get(port);
        if (!list || list.listToken !== payload.listToken) throw new Error("Read the subject list in this session first");
        await requireCurrentPage(list.tabId);
        result = await sendToPage(list.tabId, { action, listToken: list.listToken, subjectCode: payload.subjectCode });
      } else {
        result = await sendScoped(configuredSession(port), { action });
      }
      sessions.delete(port);
      subjectLists.delete(port);
      return result;
    } finally { mutationInFlight = false; }
  }
  if (action === "read_current_question") return readCurrent(port);
  if (action === "inspect_page") return inspectPage();
  if (action === "set_exam_pacing") {
    if (mutationInFlight) throw new Error("Cannot change pacing during a running action");
    const session = configuredSession(port);
    const durationMinutes = payload.durationMinutes;
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 720) throw new Error("durationMinutes must be between 0 and 720");
    if (durationMinutes && (session.scope.mode !== "final" || !/^https:\/\/(?:www\.)?int-project\.com$/u.test(session.scope.origin))) throw new Error("Timed pacing requires INT final-only scope");
    session.scope = { ...session.scope, durationMinutes };
    return { scope: session.scope, durationMinutes, timing: "Minimum duration per attempt from final entry; delays may take longer" };
  }
  if (action === "set_exam_loop") {
    if (mutationInFlight) throw new Error("Cannot change loop mode during a running action");
    const session = configuredSession(port);
    if (typeof payload.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (payload.enabled && (session.scope.mode !== "final" || !/^https:\/\/(?:www\.)?int-project\.com$/u.test(session.scope.origin))) throw new Error("Perfect-score looping requires INT final-only scope");
    session.scope = { ...session.scope, retryUntilPerfect: payload.enabled };
    session.completed = false;
    return { scope: session.scope, loopMode: payload.enabled ? "loop_until_50" : "normal", tabId: session.tabId };
  }
  if (action === "set_scope") return setScope(port, payload);
  if (action === "set_current_exam_scope") return setCurrentExamScope(port, payload);
  if (mutations.has(action)) {
    if (configuredSession(port).scope.mode === "exam" && action !== "answer_and_next" && !(action === "submit_current_exam" && configuredSession(port).scope.submissionAllowed === true)) throw new Error("Current-exam scope allows answers only; submission and chapter navigation are disabled");
    if (mutationInFlight) throw new Error("Another practice-page mutation is already running");
    mutationInFlight = true;
    try {
      if (action === "answer_and_next") return await answerAndNext(payload, port);
      if (action === "advance_subject" || action === "complete_current_lesson") {
        const result = action === "advance_subject" ? await advanceSubject(port) : await completeCurrentLesson(port);
        configuredSession(port).completed = ["complete", "chapter_complete"].includes(result.mode);
        return result;
      }
      return await submitCurrentExam(payload, port);
    } finally {
      mutationInFlight = false;
    }
  }
  throw new Error(`Unknown bridge action: ${action}`);
};

updateBadge();
for (const port of BRIDGE_PORTS) connect(port);
