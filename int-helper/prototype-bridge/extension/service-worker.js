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

const isVirtualScope = (scope) => scope?.origin === "https://main.virtualschool.club";
const resetAttemptState = (session) => {
  session.attemptAnswers = new Map();
  session.submitted = false;
  session.submissionConfirmed = false;
  session.submissionExamCode = null;
  session.submittedMarker = null;
  session.reviewOpened = null;
  session.reviewSheet = null;
  session.rejectedQuestions = new Set();
};
const markVirtualSubmitted = (session, marker = "submitted") => {
  if (!session || !isVirtualScope(session.scope)) return false;
  // A result banner can be read more than once after this bridge has already
  // claimed the marker.  Keep that read idempotent for the same attempt while
  // refusing a different marker or a marker from a fresh, unconfirmed attempt.
  if (session.submitted && session.submittedMarker && (!marker || marker === session.submittedMarker)) return true;
  if (!session.submissionConfirmed) return false;
  const activity = session.scope.virtualActivity;
  const total = Number(activity?.totalQuestions);
  const hasConfirmedCode = typeof session.submissionExamCode === "string" &&
    [...(session.attemptAnswers?.values() || [])].some(answer => answer.examCode === session.submissionExamCode);
  if (!activity || !Number.isInteger(total) || total < 1 || session.attemptAnswers?.size !== total || !hasConfirmedCode) return false;
  session.submitted = true;
  session.submissionConfirmed = false;
  session.submissionExamCode = session.submissionExamCode || null;
  session.submittedMarker = marker || "submitted";
  session.scope = { ...session.scope, virtualActivity: { ...activity,
    submitted: true, submittedAt: activity.submittedAt || Date.now() } };
  return true;
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
  const scopedMessage = { ...message };
  if (message.action === "advance_subject" && isVirtualScope(session.scope) && !scopedMessage.virtualAttemptId) {
    scopedMessage.virtualAttemptId = crypto.randomUUID();
    scopedMessage.virtualAttemptEnteredAt = Date.now();
  }
  let result = await sendToPage(session.tabId, { ...scopedMessage, scope: session.scope });
  ensureSession();
  if (isVirtualScope(session.scope) && (result.submittedMarker || (result.submitted && result.terminalStatus))) {
    markVirtualSubmitted(session, result.marker || result.submittedMarker);
  }
  if (message.action === "advance_subject" && result.intActivity) {
    if (result.intActivity.enteredAt && result.intActivity.enteredAt !== session.scope.intActivity?.enteredAt) {
      resetAttemptState(session);
    }
    session.scope = { ...session.scope, intActivity: result.intActivity };
  }
  if (message.action === "advance_subject" && isVirtualScope(session.scope) && result.virtualFinalOpened) {
    const previous = session.scope.virtualActivity;
    const virtualActivity = {
      kind: "exam", examType: "F", attempt: (previous?.attempt || 0) + 1,
      attemptId: result.virtualAttemptId || scopedMessage.virtualAttemptId || crypto.randomUUID(),
      enteredAt: result.virtualAttemptEnteredAt || scopedMessage.virtualAttemptEnteredAt || Date.now(), submitted: false,
      reviewBound: false,
    };
    resetAttemptState(session);
    session.scope = { ...session.scope, virtualActivity };
    // New content adapters clear their page-local ledger before clicking and return
    // the identity. Keep the message for older adapters and isolated reload recovery.
    if (result.virtualAttemptId !== virtualActivity.attemptId) {
      await sendToPage(session.tabId, { action: "begin_virtual_attempt", attemptId: virtualActivity.attemptId, scope: session.scope });
      ensureSession();
    }
    result = { ...result, virtualActivity };
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

// Virtual School's /Course cards do not expose the course code.  Keep the
// selected-level context and the opaque card identity until the card has
// opened its real /StudyCourse route.  Progress and the route's focus flags
// are deliberately excluded from this identity: completing another card can
// change those values while the queued card token remains valid.
const VIRTUAL_ORIGIN = "https://main.virtualschool.club";
const normalizeSubjectValue = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const firstSubjectValue = (sources, keys) => {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      const value = normalizeSubjectValue(source[key]);
      if (value) return value;
    }
  }
  return null;
};
const virtualSubjectCards = (result) => Array.isArray(result?.cards)
  ? result.cards
  : Array.isArray(result?.subjects) ? result.subjects : [];
const virtualCardToken = (card) => {
  const value = card?.cardToken;
  return typeof value === "string" && value.trim() ? value : null;
};
const virtualCardCaption = (card) => firstSubjectValue([card], ["caption"]);
const virtualCardProgress = (card) => {
  const raw = card?.progress;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null;
  const match = String(raw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*%$/u);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
};
const virtualCardAction = (card) => normalizeSubjectValue(card?.action);
const virtualCardDisabled = (card, action) => card?.disabled === true || card?.isDisabled === true ||
  card?.actionDisabled === true ||
  card?.ariaDisabled === true || String(card?.ariaDisabled || "").toLowerCase() === "true" ||
  /^(?:disabled|ล็อก|ไม่พร้อม)/iu.test(action);
const normalizeVirtualCard = (card, index) => {
  const cardToken = virtualCardToken(card);
  const caption = virtualCardCaption(card);
  const progress = virtualCardProgress(card);
  const action = virtualCardAction(card);
  const disabled = virtualCardDisabled(card, action);
  const finished = card?.finished === true || progress === 100 || /^(?:finished|completed|เสร็จสิ้น|ผ่านแล้ว)/iu.test(action);
  return { cardToken, caption, progress, action, disabled, finished, index };
};
const virtualListContext = (result) => {
  // The Virtual adapter's listContext is the authoritative course-list
  // identity.  Read its actual fields directly so a stale/ambiguous alias on
  // the surrounding result cannot silently change the selected list.
  if (result?.listContext && typeof result.listContext === "object") {
    return {
      path: normalizeSubjectValue(result.listContext.path),
      level: normalizeSubjectValue(result.listContext.level),
      term: normalizeSubjectValue(result.listContext.term),
      year: normalizeSubjectValue(result.listContext.year),
    };
  }
  const sources = [result?.listContext, result, result?.listIdentity, result?.identity, result?.course, result?.scope];
  return {
    path: firstSubjectValue(sources, ["path"]),
    level: firstSubjectValue(sources, ["selectedLevel", "selectedLevelId", "levelId", "level"]),
    term: firstSubjectValue(sources, ["termId", "selectedTerm", "selectedTermId", "term"]),
    year: firstSubjectValue(sources, ["year"]),
  };
};
const virtualListIdentity = (result, origin, cards) => JSON.stringify({
  origin,
  ...virtualListContext(result),
  cards: cards.map(({ cardToken, caption }) => ({ cardToken, caption })),
});
const normalizeVirtualSubjectList = (result, tabId, fallbackOrigin = null) => {
  const origin = normalizeSubjectValue(result?.origin || fallbackOrigin);
  if (origin !== VIRTUAL_ORIGIN) throw new Error("Virtual subject list origin is missing or changed");
  const rawCards = virtualSubjectCards(result);
  if (!rawCards.length) throw new Error("Virtual subject list is empty");
  const cards = rawCards.map(normalizeVirtualCard);
  if (cards.some(card => !card.cardToken || !card.caption)) throw new Error("Virtual subject list card identity is incomplete");
  if (new Set(cards.map(card => card.cardToken)).size !== cards.length ||
      new Set(cards.map(card => card.caption)).size !== cards.length) {
    throw new Error("Virtual subject list card identity is ambiguous");
  }
  const context = virtualListContext(result);
  if (!context.level || !context.term) throw new Error("Virtual subject list level or term is missing");
  if (cards.some(card => (Object.prototype.hasOwnProperty.call(rawCards[card.index] || {}, "subjectCode") &&
      normalizeSubjectValue(rawCards[card.index]?.subjectCode)) ||
      Object.prototype.hasOwnProperty.call(rawCards[card.index] || {}, "code") ||
      Object.prototype.hasOwnProperty.call(rawCards[card.index] || {}, "subject"))) {
    throw new Error("Virtual subject list must use opaque cardToken values until StudyCourse opens");
  }
  const listToken = typeof result?.listToken === "string" && result.listToken ? result.listToken : null;
  if (!listToken) throw new Error("Virtual subject list token is missing");
  return {
    tabId, origin, virtual: true, listToken, cards, context,
    identity: virtualListIdentity(result, origin, cards),
    result,
  };
};
const virtualOpenableCard = (card) => {
  if (!card) throw new Error("Virtual subject card is missing from the current list");
  if (card.progress === null) throw new Error("Virtual subject progress is unknown; refusing to open it");
  if (card.finished || card.progress >= 100) throw new Error("Virtual subject is already finished");
  if (card.disabled || !/^(?:start|continue|เริ่มเรียน|ดำเนินการต่อ)$/iu.test(card.action)) {
    throw new Error("Virtual subject card is disabled or has no ordinary open action");
  }
};
const virtualCourseValues = (page) => {
  const course = page?.course || {};
  const params = virtualPageParams(page);
  return { course,
    code: firstSubjectValue([course], ["subjectCode"]),
    caption: firstSubjectValue([course], ["subjectName"]) || normalizeSubjectValue(params.get("title")) || firstSubjectValue([page], ["title", "caption"]),
    level: firstSubjectValue([course], ["level"]),
    selectedLevel: firstSubjectValue([course, page], ["selectedLevel"]),
    term: firstSubjectValue([course], ["term"]),
    year: firstSubjectValue([course], ["year"]),
  };
};
const virtualPageParams = (page) => {
  try {
    const url = new URL(page?.url || `${VIRTUAL_ORIGIN}${page?.path || "/"}`);
    return url.searchParams;
  } catch { return new URLSearchParams(); }
};
const virtualStudyCourseReady = (page, list, card) => {
  if (!page || normalizeSubjectValue(page.origin) !== VIRTUAL_ORIGIN || !/^\/StudyCourse\/?$/iu.test(page.path || "")) return null;
  const actual = virtualCourseValues(page);
  if (!actual.code || !actual.caption || !actual.level || !actual.term || !actual.year) return null;
  if (actual.caption !== card.caption) throw new Error("Opened Virtual subject title does not match the selected card");
  if (actual.term !== list.context.term) throw new Error("Opened Virtual subject term does not match the selected list");
  if (list.context.year && actual.year !== list.context.year) throw new Error("Opened Virtual subject year does not match the selected list");
  const params = virtualPageParams(page);
  const selectedLevel = actual.selectedLevel || normalizeSubjectValue(params.get("selectedLevel"));
  // Virtual's list route uses the displayed level (for example 6), while the
  // StudyCourse `level` query value is an opaque course level (for example J).
  // Compare the list level only with the route's selectedLevel when exposed.
  if (selectedLevel && selectedLevel !== list.context.level) throw new Error("Opened Virtual subject level does not match the selected list");
  if (!selectedLevel) throw new Error("Opened Virtual subject route does not expose its selected list level");
  return { ...page, course: { ...actual.course, subjectCode: actual.code, subjectName: actual.caption,
    level: actual.level, term: actual.term, year: actual.year } };
};
const waitForVirtualStudyCourse = async (tabId, list, card, opened, assertContext = () => {}) => {
  let lastPage = opened?.path ? opened : null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertContext();
    if (lastPage) {
      const ready = virtualStudyCourseReady(lastPage, list, card);
      if (ready) return ready;
    }
    await delay(150);
    assertContext();
    lastPage = await sendToPage(tabId, { action: "inspect_page" });
    assertContext();
  }
  throw new Error("Timed out waiting for the selected Virtual subject overview");
};
const waitForVirtualSubjectList = async (tabId, list, returned, assertContext = () => {}) => {
  let page = returned?.path ? returned : null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertContext();
    if (!page) page = await sendToPage(tabId, { action: "inspect_page" });
    assertContext();
    const origin = normalizeSubjectValue(page.origin);
    const path = page.path || "";
    if (origin === VIRTUAL_ORIGIN && /^\/Course\/?$/iu.test(path)) {
      const params = virtualPageParams(page);
      const level = params.get("level") || firstSubjectValue([page], ["selectedLevel", "level"]);
      const term = params.get("term") || firstSubjectValue([page], ["term"]);
      const year = params.get("year") || firstSubjectValue([page], ["year"]);
      if (level === list.context.level && term === list.context.term && (!list.context.year || year === list.context.year)) return page;
      throw new Error("Returned Virtual subject list level, term or year does not match the saved list");
    }
    await delay(150);
    page = null;
  }
  throw new Error("Timed out waiting for the Virtual subject list");
};

const setCurrentExamScope = async (port, { examCode, allowSubmit }) => {
  if (mutationInFlight) throw new Error("Cannot change scope during a running action");
  if (typeof examCode !== "string" || !examCode) throw new Error("Read the current question to obtain examCode first");
  const { tab } = await inspectActivePage();
  const scope = await sendToPage(tab.id, { action: "bind_current_exam", expectedExamCode: examCode, examBinding: crypto.randomUUID(), allowSubmit: allowSubmit === true });
  const session = { scope, tabId: tab.id, port };
  resetAttemptState(session);
  sessions.set(port, session);
  return { scope, tabId: tab.id };
};

const setScope = async (port, { subjectCode, mode, chapter, allowEmptyPretest, retryUntilPerfect, autoSubmit }) => {
  if (mutationInFlight) throw new Error("Cannot change scope during a running action");
  if (!["chapter", "subject", "final"].includes(mode) || (mode === "chapter" && (!Number.isInteger(chapter) || chapter < 1))) throw new Error("Invalid scope");
  const { tab, page } = await inspectActivePage();
  const int = /^https:\/\/(?:www\.)?int-project\.com$/u.test(page.origin);
  const virtual = page.origin === "https://main.virtualschool.club";
  if (retryUntilPerfect && ((!int && !virtual) || mode !== "final")) throw new Error("Perfect-score looping requires a supported final-only scope");
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
  const scope = { ...course, origin: page.origin, mode, chapter, chapterTitle, allowEmptyPretest, retryUntilPerfect: retryUntilPerfect === true, autoSubmit: autoSubmit === true };
  const session = { scope, tabId: tab.id, port };
  resetAttemptState(session);
  sessions.set(port, session);
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
  const virtual = session.scope?.origin === "https://main.virtualschool.club";
  const total = Number(question.totalQuestions);
  if (!Number.isInteger(total) || total < 1 || total > 1000 || !Number.isInteger(question.questionNumber) || question.questionNumber < 1 || question.questionNumber > total) {
    throw new Error(virtual ? "Timed pacing requires an observed positive Virtual School question total" : "Timed pacing requires exactly 50 questions");
  }
  if (!virtual && total !== 50) throw new Error("Timed pacing requires exactly 50 questions");
  const activity = virtual ? session.scope.virtualActivity : session.scope.intActivity;
  const startedAt = activity?.enteredAt;
  if (!Number.isFinite(startedAt)) throw new Error("Timed pacing requires entering the final through the scoped overview");
  if (virtual && activity.totalQuestions && activity.totalQuestions !== total) throw new Error("Virtual School question total changed during this attempt");
  if (virtual && !activity.totalQuestions) {
    session.scope = { ...session.scope, virtualActivity: { ...activity, totalQuestions: total } };
  }
  const durationMs = minutes * 60_000;
  // Anchor the last answer to the requested finish time, including manual-submit
  // runs. The old /total formula finished the answers one interval too early.
  const dueAt = startedAt + durationMs * (submitting || total === 1 ? 1 : (question.questionNumber - 1) / (total - 1));
  const waitMs = Math.max(0, Math.ceil(dueAt - Date.now()));
  return waitMs ? { ok: true, mode: "pacing", action: "waiting", answerApplied: false, done: false,
    examCode, questionNumber: question.questionNumber, waitMs, waitUntil: new Date(dueAt).toISOString(),
    targetCompletionAt: new Date(startedAt + durationMs).toISOString(),
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
  const captureAttempt = (session.scope?.origin === "https://main.virtualschool.club" && session.scope.virtualActivity?.examType === "F") ||
    session.scope.mode === "final" || session.scope.retryUntilPerfect;
  const question = captureAttempt
    ? await sendScoped(session, { action: "read_question" }) : null;
  if (question && question.examCode !== examCode) return resyncQuestion(session, "answer_and_next");
  let selected;
  try { selected = await sendScoped(session, {
    action: "apply_answer",
    choiceIndex,
    expectedExamCode: examCode,
    save: save === true,
  }); } catch (error) { if (isStaleQuestion(error)) return resyncQuestion(session, "answer_and_next"); throw error; }
  if (question) {
    if (session.scope?.origin === "https://main.virtualschool.club" && session.scope.virtualActivity) {
      const total = Number(question.totalQuestions);
      if (!Number.isInteger(total) || total < 1 || total > 1000) throw new Error("Virtual School question total is missing or invalid");
      if (session.scope.virtualActivity.totalQuestions && session.scope.virtualActivity.totalQuestions !== total) {
        throw new Error("Virtual School question total changed during this attempt");
      }
      session.scope = { ...session.scope, virtualActivity: { ...session.scope.virtualActivity, totalQuestions: total } };
    }
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
  if (session.scope.mode !== "exam" && !session.scope.retryUntilPerfect && session.scope.autoSubmit !== true) {
    return { ok: true, mode: "awaiting_user_submission", action: "manual_submission_required", submitted: false,
      examCode, autoSubmit: false, message: "Automatic whole-exam submission is disabled. Let the user review and submit, then read the result before continuing." };
  }
  const virtual = session.scope?.origin === "https://main.virtualschool.club";
  if (virtual) {
    const status = await sendScoped(session, { action: "read_submission_status" });
    if (status.submitted) {
      const ownedAttempt = markVirtualSubmitted(session, status.marker);
      return { ...status, mode: "result", action: "already_submitted", submitted: true, ownedAttempt };
    }
    if (session.submissionConfirmed && !session.submitted) {
      return { ok: true, mode: "submission", action: "confirmation_pending", submitted: false, examCode };
    }
  }
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
  if (result.action === "confirmed") {
    if (virtual) {
      session.submissionConfirmed = true;
      session.submissionExamCode = submittedCode;
    }
    else session.submitted = true;
  }
  if (result.submitted || result.action === "already_submitted") {
    if (virtual) {
      const ownedAttempt = markVirtualSubmitted(session, result.marker);
      if (!ownedAttempt) return { ...result, examCode: submittedCode, submitted: true, ownedAttempt: false,
        ...(submittedCode !== examCode ? { codeRefreshed: true } : {}) };
    }
    else session.submitted = true;
  }
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

const normalizeReviewText = (value) => String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
const reviewChoiceKey = (choice) => JSON.stringify([normalizeReviewText(choice?.text), choice?.image || null]);
const reviewQuestionKey = (question) => JSON.stringify([
  normalizeReviewText(question?.questionText), question?.questionImage || null,
  (question?.choices || []).map(reviewChoiceKey).sort(),
]);
const uniqueReviewNumberSet = (reviews, total) => {
  const numbers = reviews.map(review => review.questionNumber);
  return reviews.length === total && new Set(numbers).size === total &&
    numbers.every(number => Number.isInteger(number) && number >= 1 && number <= total) &&
    Array.from({ length: total }, (_, index) => index + 1).every(number => numbers.includes(number));
};
const virtualReviewFailure = (result, reason) => ({ ...result, reviewBound: false, boundAttemptId: null, reviewBindingError: reason,
  reviewPlan: { sheetRead: result.reviewLayout === "all", verifiedCount: 0,
    remainingCount: result.totalQuestions || result.score?.total || null, done: false,
    nextStep: result.reviewLayout === "single" ? "sheet" : null } });

// Virtual review URLs have no attempt identifier. Bind only a complete review that the
// bridge opened after this attempt's submitted marker and whose full question set matches
// the answers captured by this session.
const bindVirtualReview = (session, result) => {
  const activity = session.scope.virtualActivity;
  if (!activity || !session.submitted || !session.reviewOpened || session.reviewOpened.attemptId !== activity.attemptId) {
    return virtualReviewFailure(result, "Virtual review is not bound to this submitted attempt");
  }
  const total = Number(result.totalQuestions || result.score?.total || activity.totalQuestions);
  const reviews = result.verifiedReviews || [];
  if (result.reviewLayout !== "all" || result.reviewComplete !== true || !Number.isInteger(total) || total < 1 || total > 1000 ||
      !uniqueReviewNumberSet(reviews, total)) return virtualReviewFailure(result, "Virtual review is not a complete observed set");
  if (result.examCode !== undefined && result.examCode !== null) return virtualReviewFailure(result, "Virtual review must not use a review attempt code");
  if (!result.score || result.score.total !== total || !Number.isInteger(result.score.correct) || result.score.correct < 0 || result.score.correct > total) {
    return virtualReviewFailure(result, "Virtual review score is missing or does not match its observed total");
  }
  const answers = session.attemptAnswers;
  if (!answers || answers.size !== total) return virtualReviewFailure(result, "Virtual review does not match the complete submitted answer ledger");
  const rejectedReviews = [];
  for (const review of reviews) {
    const saved = answers.get(review.questionNumber);
    if (!saved || reviewQuestionKey(saved) !== reviewQuestionKey(review)) {
      return virtualReviewFailure(result, `Virtual review question ${review.questionNumber} does not match this attempt`);
    }
    if (!Number.isInteger(saved.selectedChoiceIndex)) {
      return virtualReviewFailure(result, `Virtual attempt answer ${review.questionNumber} is missing its selected choice`);
    }
    const correctReviewChoice = review.choices?.find(choice => choice.index === review.correctChoiceIndex);
    const selectedSavedChoice = saved.choices?.find(choice => choice.index === saved.selectedChoiceIndex);
    const correctMatches = review.choices?.filter(choice => reviewChoiceKey(choice) === reviewChoiceKey(correctReviewChoice)) || [];
    const selectedMatches = review.choices?.filter(choice => reviewChoiceKey(choice) === reviewChoiceKey(selectedSavedChoice)) || [];
    if (correctMatches.length !== 1 || selectedMatches.length !== 1) {
      return virtualReviewFailure(result, `Virtual review question ${review.questionNumber} has an ambiguous choice mapping`);
    }
    if (review.selectionState === "unanswered" ||
        (review.selectedChoiceIndex !== null && review.selectedChoiceIndex !== undefined && review.selectedChoiceIndex !== selectedMatches[0].index)) {
      return virtualReviewFailure(result, `Virtual review selection ${review.questionNumber} does not match this attempt`);
    }
    if (selectedMatches[0].index !== correctMatches[0].index) {
      rejectedReviews.push({ ...review, selectedChoiceIndex: selectedMatches[0].index,
        correctness: "incorrect", verificationSource: "Virtual School explicit correct-answer label",
        selectionSource: "bound_attempt_ledger", evidence: review.evidence || `Question ${review.questionNumber}: explicit correct answer` });
    }
  }
  const knownCorrectness = reviews.every(review => ["correct", "incorrect"].includes(review.correctness));
  const computedCorrect = total - rejectedReviews.length;
  if (computedCorrect !== result.score.correct) return virtualReviewFailure(result, "Virtual review correctness does not match its observed score");
  if (knownCorrectness && reviews.filter(review => review.correctness === "correct").length !== result.score.correct) {
    return virtualReviewFailure(result, "Virtual review correctness does not match its observed score");
  }
  const nextActivity = { ...activity, totalQuestions: total, finalResult: result.score,
    submitted: true, reviewBound: true, reviewComplete: true, reviewAttemptId: activity.attemptId };
  session.scope = { ...session.scope, virtualActivity: nextActivity };
  return { ...result, reviewBound: true, boundAttemptId: activity.attemptId, rejectedReviews,
    reviewBindingError: null, reviewPlan: { sheetRead: true, greenCount: computedCorrect,
      redCount: rejectedReviews.length, verifiedCount: total, remainingCount: 0,
      correctedQuestionNumbers: rejectedReviews.map(review => review.questionNumber),
      needsReview: [], nextQuestionNumber: null, nextStep: null, done: true } };
};

const reviewIsVirtualScope = (scope) => scope?.origin === "https://main.virtualschool.club";
const mutations = new Set(["answer_and_next", "advance_subject", "complete_current_lesson", "submit_current_exam"]);

// Keep navigation and its evidence read in one bounded request; never answer or submit here.
const readReviewResult = async (tabId, session) => {
  const scoped = session && session.scope.mode !== "exam" ? { scope: session.scope } : {};
  let result = await sendToPage(tabId, { action: "read_exam_result", ...scoped });
  if (session?.scope && reviewIsVirtualScope(session.scope) && result.submittedMarker) {
    markVirtualSubmitted(session, result.marker || result.submittedMarker);
  }
  if (session?.scope.intActivity?.examType === "F" && result.score) {
    session.scope = { ...session.scope, intActivity: { ...session.scope.intActivity, finalResult: result.score } };
  }
  // Virtual review evidence is scoped to the attempt that opened the review;
  // the same binding can be used for a chapter posttest when its adapter
  // supplies a complete observed review. Normal completion never waits for
  // this branch: it is only reached by an explicit result/review read.
  if (session?.scope && reviewIsVirtualScope(session.scope) && session.scope.virtualActivity) {
    result = bindVirtualReview(session, result);
  }
  if (session?.scope.retryUntilPerfect && !reviewIsVirtualScope(session.scope) && result.verificationSource) {
    if (result.totalQuestions !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
    result = selectiveReview(session, result);
  }
  const loopMode = session?.scope.retryUntilPerfect
    ? (reviewIsVirtualScope(session.scope) ? "loop_until_full" : "loop_until_50") : "normal";
  return { ...result, ...(session?.scope ? { scope: session.scope } : {}), loopMode };
};
const navigateReview = async (tabId, session, payload, assertSession = () => {}) => {
  assertSession();
  const scoped = session && session.scope.mode !== "exam" ? { scope: session.scope } : {};
  const navigate = (token, step = payload.step) => { assertSession(); return sendToPage(tabId, { action: "open_answer_review", expectedResultToken: token, step, questionNumber: payload.questionNumber, ...scoped }); };
  let navigation = await navigate(payload.resultToken);
  if (session && reviewIsVirtualScope(session.scope) && payload.step === "open" && session.submitted && navigation.action === "opened_review") {
    session.reviewOpened = { attemptId: session.scope.virtualActivity?.attemptId || null, resultToken: payload.resultToken };
  }
  if (payload.readAfter === false || payload.step === "return" || navigation.done) return navigation;
  let needsJump = payload.step === "question" && navigation.action === "opened_sheet";
  let openedVirtualSheet = false;
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
    const virtual = reviewIsVirtualScope(session?.scope) || (result.url && new URL(result.url).origin === "https://main.virtualschool.club");
    // The single view is only the entry point. The site's bulk view contains
    // explicit answers for greens and reds, so one read can bind the whole set.
    if (virtual && payload.step === "open" && result.reviewLayout === "single" && result.ready && !openedVirtualSheet) {
      navigation = await navigate(result.resultToken, "sheet");
      openedVirtualSheet = true;
      continue;
    }
    const ready = virtual
      ? payload.step === "sheet" || payload.step === "open" ? result.reviewLayout === "all" && result.reviewComplete === true
      : payload.step === "question" ? result.reviewLayout === "single" && result.ready && result.questionNumber === payload.questionNumber
      : payload.step === "close" ? result.reviewLayout === "single" && !result.sheet?.length
      : result.resultToken !== payload.resultToken && (result.reviewLayout === "single" || result.reviewLayout === "all")
      : payload.step === "question" ? result.questionNumber === payload.questionNumber && !result.sheet?.length
      : payload.step === "sheet" ? result.sheet?.length > 0
      : payload.step === "close" ? !result.sheet?.length
      : result.resultToken !== payload.resultToken;
    if (ready) return { ...result,
      verifiedReviews: virtual && result.reviewComplete ? (result.verifiedReviews || []) : verified,
      rejectedReviews: virtual && result.reviewComplete ? (result.rejectedReviews || []) : rejected,
      navigationAction: navigation.action };
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
    const { tab, page } = await inspectActivePage();
    const result = await sendToPage(tab.id, { action });
    const virtualListResult = page.origin === VIRTUAL_ORIGIN &&
      (Array.isArray(result.cards) || result.virtual === true || result.listKind === "virtual" ||
        (Array.isArray(result.subjects) && result.subjects.some(card => typeof card?.cardToken === "string")));
    if (virtualListResult || result.origin === VIRTUAL_ORIGIN && Array.isArray(result.cards)) {
      const list = normalizeVirtualSubjectList(result, tab.id, page.origin);
      subjectLists.set(port, list);
    } else {
      subjectLists.set(port, { tabId: tab.id, origin: page.origin, listToken: result.listToken, result });
    }
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
        const ensureList = () => {
          if (subjectLists.get(port) !== list) throw new Error("Subject list scope expired; read_subjects again");
        };
        ensureList();
        await requireCurrentPage(list.tabId);
        ensureList();
        if (list.virtual === true) {
          if (list.opened) throw new Error("Read the subject list in this session first");
          if (typeof payload.cardToken !== "string" || !payload.cardToken) throw new Error("Virtual subject opening requires the opaque cardToken from read_subjects");
          if (Object.prototype.hasOwnProperty.call(payload, "subjectCode")) throw new Error("Virtual subjectCode is unavailable until StudyCourse opens");
          const selected = list.cards.find(card => card.cardToken === payload.cardToken);
          virtualOpenableCard(selected);
          const liveResult = await sendToPage(list.tabId, { action: "read_subjects" });
          ensureList();
          const liveList = normalizeVirtualSubjectList(liveResult, list.tabId, list.origin);
          if (liveList.identity !== list.identity) throw new Error("Subject list changed; read_subjects again");
          const liveCard = liveList.cards.find(card => card.cardToken === payload.cardToken);
          virtualOpenableCard(liveCard);
          // The caller's token identifies the queued list. After identity and
          // card revalidation, pass the current adapter token so a progress
          // refresh cannot strand an otherwise unchanged card queue.
          result = await sendToPage(list.tabId, { action, listToken: liveList.listToken, cardToken: payload.cardToken });
          ensureList();
          const overview = await waitForVirtualStudyCourse(list.tabId, list, liveCard, result, ensureList);
          ensureList();
          subjectLists.set(port, { ...list, opened: { cardToken: payload.cardToken, caption: liveCard.caption, overview } });
          sessions.delete(port);
          return { ...result, cardToken: payload.cardToken, caption: liveCard.caption,
            subjectCode: overview.course.subjectCode, course: overview.course, path: overview.path };
        }
        result = await sendToPage(list.tabId, { action, listToken: list.listToken, subjectCode: payload.subjectCode });
      } else {
        const session = configuredSession(port);
        if (isVirtualScope(session.scope)) {
          if (session.scope.mode !== "subject") throw new Error("Return to subjects requires a scoped Virtual subject overview");
          const list = subjectLists.get(port);
          if (!list?.opened) throw new Error("The scoped Virtual subject was not opened from a verified subject list");
          const ensureSession = () => {
            if (sessions.get(port) !== session || subjectLists.get(port) !== list) throw new Error("Scope expired; set it again before continuing");
          };
          ensureSession();
          const currentPage = await sendToPage(session.tabId, { action: "inspect_page" });
          ensureSession();
          const currentCourse = virtualCourseValues(currentPage);
          const openedCourse = list.opened.overview.course;
          if (!/^\/StudyCourse\/?$/iu.test(currentPage.path || "") ||
              currentCourse.code !== openedCourse.subjectCode || currentCourse.caption !== openedCourse.subjectName ||
              currentCourse.term !== openedCourse.term || currentCourse.year !== openedCourse.year ||
              currentCourse.code !== session.scope.subjectCode) {
            throw new Error("Current Virtual subject overview does not match the opened scoped subject");
          }
          result = await sendScoped(session, { action });
          ensureSession();
          if (result.action !== "returned_to_subjects") throw new Error("Virtual subject return did not use the observed back button");
          await waitForVirtualSubjectList(session.tabId, list, result, ensureSession);
          ensureSession();
        } else {
          result = await sendScoped(session, { action });
        }
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
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 119) throw new Error("durationMinutes must be between 0 and 119; the exam limit is 120 minutes, with one minute reserved for submission");
    const intFinal = session.scope.mode === "final" && /^https:\/\/(?:www\.)?int-project\.com$/u.test(session.scope.origin);
    const virtualFinal = isVirtualScope(session.scope) && session.scope.mode === "final";
    if (durationMinutes && !intFinal && !virtualFinal) throw new Error("Timed pacing requires a supported final-only scope");
    session.scope = { ...session.scope, durationMinutes };
    return { scope: session.scope, durationMinutes, examLimitMinutes: 120,
      timing: "Space answers from final entry so the last answer targets the requested duration. Do not add a fresh delay after every answer; late actions skip elapsed waits. Website and reasoning delays can overrun the target." };
  }
  if (action === "set_exam_loop") {
    if (mutationInFlight) throw new Error("Cannot change loop mode during a running action");
    const session = configuredSession(port);
    if (typeof payload.enabled !== "boolean") throw new Error("enabled must be boolean");
    const intFinal = session.scope.mode === "final" && /^https:\/\/(?:www\.)?int-project\.com$/u.test(session.scope.origin);
    const virtualFinal = isVirtualScope(session.scope) && session.scope.mode === "final";
    if (payload.enabled && !intFinal && !virtualFinal) throw new Error("Perfect-score looping requires a supported final-only scope");
    session.scope = { ...session.scope, retryUntilPerfect: payload.enabled };
    session.completed = false;
    return { scope: session.scope, loopMode: payload.enabled ? (isVirtualScope(session.scope) ? "loop_until_full" : "loop_until_50") : "normal", tabId: session.tabId };
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
