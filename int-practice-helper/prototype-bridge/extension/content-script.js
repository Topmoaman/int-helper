(() => {
  if (globalThis.__intPracticeBridgeInstalled) return;
  globalThis.__intPracticeBridgeInstalled = true;

  const wakeBridge = () => chrome.runtime.sendMessage({ action: "keep_bridge_awake" }).catch(() => {});
  wakeBridge();
  setInterval(wakeBridge, 20_000);

  const examCode = (root) =>
    (root?.innerText || "").match(/รหัสข้อสอบ\s*:\s*([^\s|]+)/u)?.[1] || null;

  let pendingIntSave = null;
  let intVerifiedSheet = null;
  let currentExamBinding = null;
  const readIntQuestion = () => {
    const root = document.querySelector("#main_quizs");
    if (!root) throw new Error("main_quizs not found");

    const children = [...root.children];
    const headingIndex = children.findIndex((element) => /คำถามข้อที่\s*\d+/u.test(element.innerText || ""));
    const heading = children[headingIndex];
    const question = children[headingIndex + 1];
    const number = Number((heading?.innerText || "").match(/คำถามข้อที่\s*(\d+)/u)?.[1]);
    const code = examCode(root);
    if (headingIndex < 0 || !question || !number || !code) throw new Error("question metadata not found");

    const choices = [...root.querySelectorAll('input[type="radio"][name="rdoAns"]')].map((radio, position) => {
      const index = Number(radio.id.match(/\d+$/)?.[0]) || position + 1;
      const label = document.getElementById(`A${index}`);
      const image = label?.querySelector("img");
      return {
        index,
        text: (label?.innerText || "").trim(),
        image: image?.currentSrc || image?.src || null,
        checked: radio.checked,
      };
    });
    if (!choices.length) throw new Error("answer choices not found");

    const image = question.querySelector("#imgQ, img");
    return {
      ok: true,
      questionNumber: number,
      totalQuestions: intExamTotal(),
      saving: !!pendingIntSave && document.querySelector("#save_exam") === pendingIntSave,
      examCode: code,
      questionText: (question.innerText || "").trim(),
      questionImage: image?.currentSrc || image?.src || null,
      choices,
      done: false,
    };
  };

  const virtualSchoolMetadata = () => {
    const number = Number((document.querySelector("main h2")?.innerText || "").match(/ข้อคำถามที่\s*(\d+)/u)?.[1]);
    const code = examCode(document.body);
    if (!number || !code) throw new Error("question metadata not found");
    return { number, code, token: `${code}:${number}` };
  };

  const observedAnswers = new Map();
  const virtualQuestionImage = () => document.querySelector('main img[src*="/question_pic/"]');
  const readVirtualSchoolQuestion = () => {
    if (!/^\/Exam\/?$/iu.test(location.pathname)) {
      throw new Error(`Current page is ${location.pathname}, not an exam question; use inspect_page`);
    }
    if (/ส่งคำตอบเรียบร้อยแล้ว/u.test(document.body?.innerText || "")) {
      throw new Error("Exam already submitted; use inspect_page or advance_subject to inspect the result");
    }
    const question = document.querySelector(".exam-question");
    const image = virtualQuestionImage();
    if (!question && !image) throw new Error("Exam question is not ready; inspect the page before retrying");
    const { number, token } = virtualSchoolMetadata();
    const choices = [...document.querySelectorAll('main input[type="radio"]')].map((radio, position) => {
      const content = radio.nextElementSibling;
      const image = content?.querySelector("img");
      return {
        index: position + 1,
        text: (content?.innerText || radio.value || "").trim(),
        image: image?.currentSrc || image?.src || null,
        checked: radio.checked,
      };
    });
    if (!choices.length) throw new Error("answer choices not found");
    const checked = choices.find((choice) => choice.checked);
    if (checked) observedAnswers.set(token, checked.index);
    else observedAnswers.delete(token);
    return {
      ok: true,
      questionNumber: number,
      examCode: token,
      questionText: (question?.innerText || "").trim(),
      questionImage: image?.currentSrc || image?.src || null,
      choices,
      done: false,
    };
  };

  const readQuestion = () =>
    location.hostname === "main.virtualschool.club" ? readVirtualSchoolQuestion() : readIntQuestion();

  const applyIntAnswer = ({ choiceIndex, expectedExamCode, save }) => {
    const current = readIntQuestion();
    if (current.examCode !== String(expectedExamCode)) throw new Error(`stale exam code: ${current.examCode}`);
    if (save !== true) throw new Error("INT Project requires save=true: its Save button persists the answer and advances automatically");
    if (intDialog()) throw new Error("Close the current INT dialog before answering");
    const button = document.querySelector("#save_exam");
    if (!visible(button) || current.saving) throw new Error("save button unavailable or previous save is pending");
    const radio = document.querySelector(`#rdoAns${Number(choiceIndex)}`);
    if (!radio) throw new Error("answer choice not found");
    intVerifiedSheet = null;
    radio.click();
    if (!radio.checked) throw new Error("answer choice was not selected");
    pendingIntSave = button;
    button.click();
    return { ok: true, examCode: current.examCode, selected: Number(choiceIndex), saved: null,
      selectionVerified: true, saveRequested: true, persistence: "unverified_until_submission",
      autoAdvance: true, lastQuestion: current.questionNumber === current.totalQuestions };
  };

  const applyVirtualSchoolAnswer = ({ choiceIndex, expectedExamCode, save }) => {
    const { examCode: token } = readVirtualSchoolQuestion();
    if (token !== String(expectedExamCode)) throw new Error(`stale exam code: ${token}`);
    const radio = [...document.querySelectorAll('main input[type="radio"]')][Number(choiceIndex) - 1];
    if (!radio) throw new Error("answer choice not found");
    radio.click();
    if (!radio.checked) throw new Error("answer choice was not selected");
    observedAnswers.set(token, Number(choiceIndex));
    return { ok: true, examCode: token, selected: Number(choiceIndex), saved: null,
      selectionVerified: true, saveRequested: save === true, persistence: "unverified_until_submission" };
  };

  const applyAnswer = (message) =>
    location.hostname === "main.virtualschool.club"
      ? applyVirtualSchoolAnswer(message)
      : applyIntAnswer(message);

  const navigateIntNext = ({ expectedExamCode }) => {
    const root = document.querySelector("#main_quizs");
    const currentExamCode = examCode(root);
    if (!currentExamCode || currentExamCode !== String(expectedExamCode)) {
      throw new Error(`stale exam code: ${currentExamCode || "missing"}`);
    }
    const link = [...document.querySelectorAll("a")].find(
      (element) => (element.innerText || "").trim() === "ข้อถัดไป",
    );
    if (!link) return { ok: true, done: true };
    setTimeout(() => link.click(), 0);
    return { ok: true, done: false };
  };

  const navigateVirtualSchoolNext = ({ expectedExamCode }) => {
    const { token } = virtualSchoolMetadata();
    if (token !== String(expectedExamCode)) throw new Error(`stale exam code: ${token}`);
    const button = [...document.querySelectorAll("main button")].find(
      (element) => (element.innerText || "").trim() === "ข้อถัดไป",
    );
    if (!button || button.disabled) return { ok: true, done: true };
    button.click();
    return { ok: true, done: false };
  };

  const navigateNext = (message) =>
    location.hostname === "main.virtualschool.club"
      ? navigateVirtualSchoolNext(message)
      : navigateIntNext(message);

  const text = (element) => (element?.innerText || "").replace(/\s+/g, " ").trim();
  const label = (element) => [element?.getAttribute?.("aria-label"), text(element), element?.title]
    .filter(Boolean)
    .join(" ");
  const visible = (element) =>
    element && !element.disabled && (!element.getClientRects || element.getClientRects().length > 0);

  const pageUrl = () => new URL(location.href);
  const courseIdentity = () => {
    if (isInt()) return intCourseIdentity();
    const params = pageUrl().searchParams;
    const subjects = ["subject", "subjectCode", "subj", "code"].map((key) => params.get(key)).filter(Boolean);
    if (new Set(subjects).size > 1) throw new Error("Conflicting subject identifiers");
    return { subjectCode: subjects[0] || null, level: params.get("level"),
      term: params.get("term"), year: params.get("year") };
  };
  const chapterCards = () => isInt() ? intChapterCards() : [...document.querySelectorAll("article")].map((card) => {
    const header = card.querySelector("button");
    const number = Number(text(header).match(/^บทที่\s*(\d+)(?:\s|$)/u)?.[1]);
    return { card, header, number, title: text(header?.querySelector("h4")) };
  }).filter(({ number }) => number > 0);

  const isInt = () => /^(?:www\.)?int-project\.com$/u.test(location.hostname);
  const intOverview = () => /^\/student\/virtual_school\/(?:index\.php)?$/u.test(location.pathname);
  const intCourseIdentity = () => {
    const summary = text(document.querySelector(".retroshadow"));
    const exams = [...document.querySelectorAll('a.exam[examtype="P"][href]')];
    const unique = (key) => {
      const values = new Set(exams.map((e) => e.getAttribute(key)).filter(Boolean));
      return values.size === 1 ? [...values][0] : null;
    };
    const finals = [...document.querySelectorAll('a.exam[examtype="F"]')];
    const final = finals.length === 1 ? finals[0] : null;
    const navigation = final ? { levelId: final.getAttribute("level"), termId: final.getAttribute("term"), rangeId: final.getAttribute("ranglevel") } : null;
    // INT's exam attributes are opaque IDs, not the base64 IDs on lesson links.
    return { subjectCode: unique("subj"), year: unique("year"), navigation,
      level: summary.match(/ปีที่\s*(\d+)/u)?.[1] || null,
      term: summary.match(/ภาคเรียนที่\s*(\d+)/u)?.[1] || null,
      subjectName: summary.match(/วิชา\s*(.+)$/u)?.[1] || null };
  };
  const intChapterCards = () => [...document.querySelectorAll(".panel-warning")].map((card) => {
    const header = card.querySelector(":scope > .panel-heading");
    const match = text(header).match(/^หน่วยการเรียนรู้ที่\s*(\d+)\s+(.+)$/u);
    return { card, header, number: Number(match?.[1]), title: match?.[2] || "" };
  }).filter(({ number }) => number > 0);
  const intExamTotal = () => {
    const total = Number(text(document.body).match(/จำนวนข้อสอบ\s*(\d+)\s*ข้อ/u)?.[1]);
    if (!total || total > 1000) throw new Error("INT exam total is missing or invalid");
    return total;
  };
  const scopedReturnTarget = (scope) => {
    const activity = scope.intActivity, identity = scope.navigation;
    if (scope.mode !== "final" || !scope.retryUntilPerfect || activity?.finalResult?.total !== 50 ||
        activity.finalResult.correct >= 50 || !Array.from({ length: 50 }, (_, i) => i + 1).every(n => activity.reviewedQuestions?.includes(n)) ||
        !identity?.levelId || !identity.termId || !identity.rangeId) return null;
    const screens = [
      ['a.term[href="check_error.php"][level][ranglevel]', [["level", identity.levelId], ["ranglevel", identity.rangeId]], "selected_level"],
      ['a.subject[href="check_error.php"][level][ranglevel][termid]', [["level", identity.levelId], ["ranglevel", identity.rangeId], ["termid", identity.termId]], "selected_term"],
      ['a.learn[href="check_error.php"][subj][term][level][ranglevel]', [["level", identity.levelId], ["ranglevel", identity.rangeId], ["term", identity.termId], ["subj", scope.subjectCode]], "reopened_subject"],
    ];
    for (const [selector, attributes, action] of screens) {
      const controls = [...document.querySelectorAll(selector)].filter(visible);
      if (!controls.length) continue;
      const matches = controls.filter(e => attributes.every(([key,value]) => e.getAttribute(key) === value));
      if (matches.length !== 1 || matches[0].disabled || matches[0].getAttribute("aria-disabled") === "true" || matches[0].classList.contains("disabled")) throw new Error("Course return controls do not match the scoped level, term and subject");
      return { control: matches[0], action };
    }
    return null;
  };
  const assertIntScope = (scope) => {
    if (intOverview()) {
      const cards = intChapterCards();
      if (!cards.length) {
        if (scope.intActivity?.finalResult && (!scope.retryUntilPerfect || scope.intActivity.finalResult.correct === 50)) return;
        if (scopedReturnTarget(scope)) return;
        throw new Error("Chapter overview is loading");
      }
      const current = intCourseIdentity();
      for (const key of ["subjectCode", "level", "term", "year", "subjectName"]) {
        if (!scope[key] || current[key] !== scope[key]) throw new Error(`Scope mismatch or missing ${key}`);
      }
      const matches = cards.filter((c) => c.number === scope.chapter);
      if (scope.mode === "chapter" && (matches.length !== 1 || matches[0].title !== scope.chapterTitle ||
          cards.filter((c) => c.title === scope.chapterTitle).length !== 1)) throw new Error("Target chapter cannot be identified");
      return;
    }
    const activity = scope.intActivity;
    if (!activity || (scope.mode === "final" && (activity.kind !== "exam" || activity.examType !== "F")) ||
        (activity.examType === "F" && scope.mode === "chapter") || (scope.mode === "chapter" && (activity.chapter !== scope.chapter || activity.title !== scope.chapterTitle))) {
      throw new Error("INT scope requires entering this activity through the scoped overview");
    }
    const params = pageUrl().searchParams;
    if (/^\/student\/virtual_school\/content\/(?:index\.php)?$/u.test(location.pathname)) {
      if (activity.kind !== "lesson" || ["content", "term", "level", "rang", "linelearn"].some((key) =>
        !activity.params[key] || params.get(key) !== activity.params[key])) throw new Error("Lesson is outside the requested INT scope");
      return;
    }
    const result = location.pathname === "/student/virtual_school/exam_result.php";
    const review = location.pathname === "/student/virtual_school/exam_answer.php";
    if (!result && !review && location.pathname !== "/student/virtual_school/exam.php") throw new Error("Page is outside the supported scoped routes");
    if (activity.kind !== "exam" || !["P", "A", "F"].includes(activity.examType)) throw new Error("Exam is outside the requested INT scope");
    const body = text(document.body);
    if (scope.retryUntilPerfect && !result && intExamTotal() !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
    const final = activity.examType === "F";
    const type = final ? "แบบทดสอบปลายภาค" : activity.examType === "P" ? "แบบทดสอบก่อนเรียน" : "แบบทดสอบหลังเรียน";
    // These PHP routes carry no course in the URL. Require the bridge's verified entry and the visible heading.
    const heading = review ? `วิชา ${scope.subjectName} หน่วยการเรียนรู้ที่ ${activity.chapter} ภาคเรียนที่ ${scope.term}` : final ? `${type} วิชา ${scope.subjectName}${result ? "" : ` ภาคเรียนที่ ${scope.term}`} ` : result
      ? `${type} วิชา ${scope.subjectName} หน่วยการเรียนรู้ ${activity.title}`
      : `${type} วิชา ${scope.subjectName} หน่วยการเรียนรู้ที่ ${activity.chapter} ${activity.title} ภาคเรียนที่ ${scope.term}`;
    if (review && (!body.includes(`เฉลยคำตอบ ${type}`) || (final && !body.replace(/\s+/gu, "").includes(`วิชา${scope.subjectName}ภาคเรียนที่${scope.term}`.replace(/\s+/gu, ""))))) throw new Error("INT review heading does not match scope");
    if (!(review && final) && !body.replace(/\s+/gu, "").includes(heading.replace(/\s+/gu, ""))) throw new Error("INT exam heading does not match the scoped activity");
  };

  const assertScope = (scope) => {
    if (scope?.mode === "exam") {
      if (!currentExamBinding || scope.examBinding !== currentExamBinding.id || location.href !== currentExamBinding.url) {
        throw new Error("Current-exam scope expired; inspect and bind the open exam again");
      }
      if (location.hostname === "main.virtualschool.club" && virtualSchoolMetadata().code !== currentExamBinding.code) {
        throw new Error("Current exam changed; inspect and bind again");
      }
      return;
    }
    if (!scope || !["chapter", "subject", "final"].includes(scope.mode)) throw new Error("Set an explicit scope before taking actions");
    if (isInt() && scope.origin === pageUrl().origin) return assertIntScope(scope);
    if (location.hostname !== "main.virtualschool.club" || scope.origin !== pageUrl().origin) {
      throw new Error("Scoped automation is only verified for main.virtualschool.club");
    }
    const current = courseIdentity();
    for (const key of ["subjectCode", "level", "term", "year"]) {
      if (!scope[key] || current[key] !== scope[key]) throw new Error(`Scope mismatch or missing ${key}`);
    }
    if (!/^\/(StudyCourse|Content|Exam|examanswers)\/?$/iu.test(location.pathname)) {
      throw new Error("Page is outside the supported scoped routes");
    }
    if (scope.mode === "final" && !/^\/StudyCourse\/?$/iu.test(location.pathname) &&
        (!/^\/(Exam|examanswers)\/?$/iu.test(location.pathname) || pageUrl().searchParams.get("examtype") !== "F")) {
      throw new Error("Page is outside the requested final exam");
    }
    if (scope.mode === "chapter" && pageUrl().searchParams.get("examtype") === "F") throw new Error("Final exam is outside the requested chapter");
    if (scope.mode === "chapter") {
      if (!Number.isInteger(scope.chapter) || scope.chapter < 1 || !scope.chapterTitle) throw new Error("Invalid chapter scope");
      if (/^\/StudyCourse\/?$/iu.test(location.pathname)) {
        const cards = chapterCards();
        if (!cards.length) {
        if (scope.intActivity?.finalResult && (!scope.retryUntilPerfect || scope.intActivity.finalResult.correct === 50)) return;
        if (scopedReturnTarget(scope)) return;
        throw new Error("Chapter overview is loading");
      }
        const matches = cards.filter((entry) => entry.number === scope.chapter);
        if (matches.length !== 1 || matches[0].title !== scope.chapterTitle || chapterCards().filter((entry) => entry.title === scope.chapterTitle).length !== 1) throw new Error("Target chapter cannot be identified");
      } else {
        const params = pageUrl().searchParams;
        if (/^\/Content\/?$/iu.test(location.pathname)) {
          if (params.get("lessonTitle") !== scope.chapterTitle) throw new Error("Lesson is outside the requested chapter");
        } else if (Number(params.get("chapter")) !== scope.chapter || params.get("SUB_SUBJECT_NAME") !== scope.chapterTitle) {
          throw new Error("Exam is outside the requested chapter");
        }
      }
    }
  };

  const isPretest = () => pageUrl().searchParams.get("examtype") === "P" &&
    /แบบทดสอบก่อนเรียน/u.test(text(document.body));
  const assertSubmission = ({ expectedExamCode, scope }) => {
    const { token, code, number } = virtualSchoolMetadata();
    if (token !== expectedExamCode) throw new Error(`stale exam code: ${token}`);
    const emptyPretestAllowed = scope.mode !== "exam" && scope.allowEmptyPretest === true && isPretest();
    if (!emptyPretestAllowed) {
      // The ledger is page-local: after reload, revisit each answer before submitting.
      const total = Number(text(document.body).match(/ทั้งหมด\s*(\d+)\s*ข้อ/u)?.[1]);
      const radios = [...document.querySelectorAll('main input[type="radio"]')];
      const checked = radios.findIndex((radio) => radio.checked);
      if (checked >= 0) observedAnswers.set(`${code}:${number}`, checked + 1);
      else observedAnswers.delete(`${code}:${number}`);
      if (!total || total > 1000 || /คุณยังทำข้อสอบไม่ครบ|ยังไม่ได้ทำอีก\s*[1-9]/u.test(text(document.body)) ||
          Array.from({ length: total }, (_, index) => `${code}:${index + 1}`).some((key) => !observedAnswers.has(key))) {
        throw new Error("Not every answer has been verified in this exam; refusing submission");
      }
    }
  };

  const intDialog = () => [...document.querySelectorAll(".modal.in")].find(visible);
  const reviewRequired = (scope) => scope.retryUntilPerfect && scope.intActivity?.finalResult?.correct !== 50 &&
    Array.from({ length: 50 }, (_, i) => i + 1).some((n) => !scope.intActivity?.reviewedQuestions?.includes(n));
  const advanceIntSubject = (scope) => {
    if (intReviewPage()) {
      if (reviewRequired(scope)) return { ok: true, mode: "review_required", reviewed: scope.intActivity.reviewedQuestions?.length || 0 };
      const back = document.querySelector("#goback");
      if (!visible(back)) return { ok: true, mode: "result", action: "waiting" };
      back.click();
      return { ok: true, mode: "result", action: "returned" };
    }
    if (location.pathname.endsWith("/exam_result.php")) {
      const back = document.querySelector(".backplan");
      if (!visible(back)) return { ok: true, mode: "result", action: "waiting" };
      if (scope.intActivity.examType === "F") {
        const body = text(document.body);
        const score = body.match(/คุณทำแบบทดสอบปลายภาค ได้ (\d+) ข้อ จากทั้งหมด (\d+) ข้อ/u);
        const status = body.match(/ผลการทดสอบ คือ (ไม่ผ่าน|ผ่าน)/u);
        if (!score || !status) return { ok: true, mode: "result", action: "waiting" };
        const finalResult = { correct: Number(score[1]), total: Number(score[2]), passed: status[1] === "ผ่าน" };
        if (scope.retryUntilPerfect) {
          if (finalResult.total !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
          if (finalResult.correct < 50) return { ok: true, mode: "review_required", finalResult, intActivity: { ...scope.intActivity, finalResult } };
        }
        back.click();
        return { ok: true, mode: "result", action: "returned", intActivity: { ...scope.intActivity, finalResult } };
      }
      back.click();
      return { ok: true, mode: "result", action: "returned" };
    }
    const dialog = intDialog();
    if (location.pathname.endsWith("/exam.php")) {
      if (dialog) return { ok: true, mode: "submission", action: "confirmation_required" };
      if (!document.querySelector('#main_quizs input[name="rdoAns"]')) return { ok: true, mode: "exam", ready: false, action: "waiting" };
      const pretest = scope.intActivity.examType === "P";
      return { ok: true, mode: "exam", pretest, needsAnswers: !(pretest && scope.allowEmptyPretest === true) };
    }
    if (location.pathname.includes("/virtual_school/content/")) {
      if (dialog) {
        const confirm = dialog.querySelector("button.confirm-save-learn");
        if (visible(confirm) && /ต้องการออกจากบทเรียนนี้/u.test(text(dialog))) {
          confirm.click();
          return { ok: true, mode: "lesson", action: "confirmed" };
        }
        return { ok: true, mode: "lesson", action: "waiting" };
      }
      const save = document.querySelector("button.save-learn");
      if (visible(save)) {
        save.click();
        return { ok: true, mode: "lesson", action: "exit_opened" };
      }
      return { ok: true, mode: "lesson", action: "waiting" };
    }
    const returning = intOverview() && !intChapterCards().length ? scopedReturnTarget(scope) : null;
    if (returning) {
      returning.control.click();
      return { ok: true, mode: "overview", action: returning.action, subjectCode: scope.subjectCode };
    }
    if (scope.intActivity?.examType === "F" && scope.intActivity.finalResult) {
      const score = scope.intActivity.finalResult;
      if (!scope.retryUntilPerfect || (score.total === 50 && score.correct === 50)) return { ok: true, mode: "complete", finalResult: score };
      if (score.total !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
      if (reviewRequired(scope)) return { ok: true, mode: "review_required", reviewed: scope.intActivity.reviewedQuestions?.length || 0 };
    }
    if (scope.intActivity?.enteredAt && !scope.intActivity.finalResult) {
      return Date.now() - scope.intActivity.enteredAt < 5000 ? { ok: true, mode: "overview", action: "waiting" }
        : { ok: true, mode: "scope_boundary", reason: "The website did not open the final exam; retake may be unavailable" };
    }
    const cards = intChapterCards().filter((c) => scope.mode !== "final" && (scope.mode === "subject" || c.number === scope.chapter));
    for (const { card, number, title } of cards) {
      const activities = [...card.querySelectorAll('a[examtype], a.learn')];
      const complete = activities.length >= 3 && activities.every((a) =>
        [...a.querySelectorAll('svg[data-icon="circle"]')].some((icon) => /color:\s*(?:#32cd32|rgb\(50,\s*205,\s*50\))/iu.test(icon.getAttribute("style") || "")));
      if (complete) {
        if (scope.mode === "chapter") return { ok: true, mode: "chapter_complete", chapter: number };
        continue;
      }
      const next = activities.find((a) => a.getAttribute("href") === "check_error.php" && a.querySelector('img[src*="yellow.gif"]'));
      if (!next) return { ok: true, mode: "overview", action: "waiting", chapter: number };
      if (!visible(next)) {
        const expand = card.querySelector(".ziehharmonika h3");
        if (visible(expand)) expand.click();
        return { ok: true, mode: "overview", action: visible(expand) ? "expanded" : "waiting", chapter: number };
      }
      const lesson = next.classList.contains("learn");
      const intActivity = { chapter: number, title, kind: lesson ? "lesson" : "exam" };
      if (lesson) {
        const fields = { content: "contents", term: "term", level: "level", rang: "ranglevel", linelearn: "linelearn" };
        intActivity.params = Object.fromEntries(Object.entries(fields).map(([key, attr]) => [key, next.getAttribute(attr)]));
        if (Object.values(intActivity.params).some((value) => !value)) throw new Error("INT lesson identity is incomplete");
      } else {
        intActivity.examType = next.getAttribute("examtype");
        if (!["P", "A"].includes(intActivity.examType) || Number(next.getAttribute("idlearn")) !== number ||
            next.getAttribute("subj") !== scope.subjectCode || next.getAttribute("year") !== scope.year) throw new Error("INT exam link does not match scope");
      }
      next.click();
      return { ok: true, mode: "overview", action: "opened", chapter: number, activity: text(next), intActivity };
    }
    if (scope.mode === "chapter") return { ok: true, mode: "scope_boundary", reason: "Requested chapter is unavailable" };
    const finals = [...document.querySelectorAll('a.exam[examtype="F"]')];
    if (finals.length !== 1) throw new Error("INT final exam is not uniquely identified");
    const final = finals[0];
    if (final.getAttribute("subj") !== scope.subjectCode || final.getAttribute("year") !== scope.year) {
      throw new Error("INT final exam link does not match scope");
    }
    const completedFinal = [...final.querySelectorAll('svg[data-icon="circle"]')].some(icon => /color:\s*(?:#32cd32|rgb\(50,\s*205,\s*50\))/iu.test(icon.getAttribute("style") || ""));
    if (scope.mode === "subject" && completedFinal) return { ok: true, mode: "complete", alreadyFinished: true };
    const normalRetake = scope.mode === "final" && completedFinal && !scope.intActivity?.finalResult;
    if (!visible(final) || final.disabled || final.getAttribute("aria-disabled") === "true" || final.classList.contains("disabled") || final.getAttribute("href") !== "check_error.php" || (!final.querySelector('img[src*="yellow.gif"]') && !normalRetake && !(scope.retryUntilPerfect && (!scope.intActivity?.finalResult || !reviewRequired(scope))))) {
      return { ok: true, mode: "scope_boundary", reason: "INT final exam is not available" };
    }
    final.click();
    return { ok: true, mode: "overview", action: "opened", activity: text(final), intActivity: { kind: "exam", examType: "F", attempt: (scope.intActivity?.attempt || 0) + 1, enteredAt: Date.now() } };
  };

  const submitIntExam = ({ expectedExamCode, scope }) => {
    const current = readIntQuestion();
    if (current.examCode !== expectedExamCode) throw new Error(`stale exam code: ${current.examCode}`);
    if (current.saving) throw new Error("Wait for the pending answer save before submission");
    const emptyAllowed = scope.allowEmptyPretest === true && scope.mode !== "exam" && scope.intActivity?.examType === "P";
    const dialog = intDialog();
    if (dialog) {
      const body = text(dialog);
      if (/กระดาษคำตอบ/u.test(body)) {
        intVerifiedSheet = null;
        const rows = [...dialog.querySelectorAll('a.tl[quesid]')];
        const answers = new Map(rows.map((r) => [Number(r.getAttribute("quesid")), text(r.querySelector(".badge"))]));
        if (rows.length !== current.totalQuestions || answers.size !== current.totalQuestions ||
            Array.from({ length: current.totalQuestions }, (_, i) => i + 1).some((n) => !/^[A-E1-5กขคงจ]$/u.test(answers.get(n) || ""))) {
          throw new Error("Not every saved answer is present in the INT answer sheet; refusing submission");
        }
        const close = dialog.querySelector("button.close");
        if (!visible(close)) throw new Error("Answer-sheet close control unavailable");
        intVerifiedSheet = current.examCode;
        close.click();
        return { ok: true, mode: "submission", action: "verified_sheet", verifiedAnswers: answers.size };
      }
      if (!/ท่านต้องการส่งคำตอบทั้งหมดใช่หรือไม่/u.test(body)) throw new Error("Unknown submission dialog; inspect the page");
      if (!emptyAllowed && (intVerifiedSheet !== current.examCode || /ท่านยังไม่ได้ทำข้อต่อไปนี้/u.test(body))) {
        throw new Error("Not every saved answer has been verified; refusing submission");
      }
      const confirm = dialog.querySelector("#btn_confirm");
      if (!visible(confirm)) return { ok: true, mode: "submission", action: "waiting" };
      confirm.click();
      return { ok: true, mode: "submission", action: "confirmed" };
    }
    const sheetNeeded = !emptyAllowed && intVerifiedSheet !== current.examCode;
    const button = document.querySelector(sheetNeeded ? "#ansedit" : "#anssend");
    if (!visible(button)) throw new Error("INT submission control unavailable");
    button.click();
    return { ok: true, mode: "submission", action: sheetNeeded ? "opened_sheet" : "opened" };
  };

  const virtualControls = () => [...document.querySelectorAll("button, a")].filter(visible);

  const advanceVirtualSubject = (scope) => {
    const controls = virtualControls();
    if (/^\/Exam\/?$/iu.test(location.pathname) && /ส่งคำตอบเรียบร้อยแล้ว/u.test(text(document.body))) {
      // Stop at the final result: never follow a control that could start another attempt.
      if (pageUrl().searchParams.get("examtype") === "F") return { ok: true, mode: "complete", submitted: true };
      // The submitted exam and its answer-sheet controls remain behind the result.
      const next = controls.find((element) => /^(เริ่มเรียนเนื้อหา|ดูเฉลยคำตอบ)$/u.test(text(element)));
      if (next) next.click();
      return { ok: true, mode: "result", action: next ? "returned" : "waiting" };
    }
    if (/^\/examanswers\/?$/iu.test(location.pathname)) {
      const back = controls.find((element) => /^(?:←\s*)?กลับไปหน้าเรียน$/u.test(text(element)));
      if (back) back.click();
      return { ok: true, mode: "result", action: back ? "returned" : "waiting" };
    }
    const dialog = document.querySelector('.swal2-container, [role="dialog"][aria-modal="true"]');
    if (/^\/Content\/?$/iu.test(location.pathname)) {
      if (/กำลังโหลดบทเรียน/u.test(text(document.body))) return { ok: true, mode: "lesson", action: "waiting" };
      if (dialog && visible(dialog)) {
        const confirmLesson = [...dialog.querySelectorAll("button, a")].find((element) =>
          visible(element) && text(element) === "ยืนยันออกบทเรียน",
        );
        if (confirmLesson && text(dialog).includes("ยืนยันการออกบทเรียน")) {
          confirmLesson.click();
          return { ok: true, mode: "lesson", action: "confirmed" };
        }
        // Never re-click the background Exit while confirmation is pending or disabled.
        return { ok: true, mode: "lesson", action: "waiting" };
      }
      const exitLesson = controls.find((element) => text(element) === "ออกจากบทเรียน");
      if (exitLesson) {
        exitLesson.click();
        return { ok: true, mode: "lesson", action: "exit_opened" };
      }
      return { ok: true, mode: "lesson", action: "waiting" };
    }
    if (dialog && visible(dialog)) {
      return { ok: true, mode: "submission", action: "confirmation_required" };
    }

    if (/^\/Exam(?:\/|$)/iu.test(location.pathname)) {
      if ((document.querySelector(".exam-question") || virtualQuestionImage()) && document.querySelectorAll('main input[type="radio"]').length) {
        const pretest = isPretest();
        return { ok: true, mode: "exam", pretest, needsAnswers: !(pretest && scope.allowEmptyPretest === true) };
      }
      return { ok: true, mode: "exam", action: "waiting", ready: false };
    }

    if (/^\/StudyCourse\/?$/iu.test(location.pathname)) {
      if (scope.mode === "subject" && /ความคืบหน้า\s*100%/u.test(text(document.body))) return { ok: true, mode: "complete" };
      const cards = chapterCards().filter((entry) => scope.mode !== "final" && (scope.mode === "subject" || entry.number === scope.chapter));
      for (const { card, header, number } of cards) {
        const local = [...card.querySelectorAll("button, a")].filter(visible);
        const pretest = local.find((element) => text(element) === "ก่อนเรียน");
        const posttest = local.find((element) => text(element) === "หลังเรียน");
        const topics = [...card.querySelectorAll('button[aria-label^="เปิดบทเรียน:"]')];
        const finished = (element) => element?.classList.contains("bg-emerald-500");
        const complete = /ผ่านเกณฑ์หน่วยเรียนแล้ว/u.test(text(card)) && finished(pretest) && finished(posttest) &&
          topics.length > 0 && topics.every((element) => element.querySelector("svg.text-emerald-500"));
        if (complete) {
          if (scope.mode === "chapter") return { ok: true, mode: "chapter_complete", chapter: number };
          continue;
        }
        if (!card.querySelector('button[aria-label^="เปิดบทเรียน:"]')) {
          if (!visible(header)) return { ok: true, mode: "overview", action: "waiting" };
          header.click();
          return { ok: true, mode: "overview", action: "expanded", chapter: number };
        }
        const lesson = topics.find((element) => visible(element) && !element.querySelector("svg.text-emerald-500") &&
          !/(?:กรุณาศึกษา|ล็อก)/u.test(label(element)));
        const activity = pretest && !finished(pretest) ? pretest : lesson || (posttest && !finished(posttest) ? posttest : null);
        if (activity) {
          activity.click();
          return { ok: true, mode: "overview", action: "opened", chapter: number, activity: label(activity) };
        }
        return { ok: true, mode: "overview", action: "waiting", chapter: number };
      }
      // Whole-subject final is entered only via the site's enabled, explicit exam control.
      const finalExam = ["subject", "final"].includes(scope.mode) && controls.find((element) => text(element) === "ทำแบบทดสอบปลายภาค");
      if (finalExam) {
        finalExam.click();
        return { ok: true, mode: "overview", action: "opened", activity: label(finalExam) };
      }
      return scope.mode === "final" ? { ok: true, mode: "scope_boundary", reason: "Final exam is not available" } : { ok: true, mode: "overview", action: "waiting" };
    }

    return { ok: true, mode: "lesson", action: "waiting" };
  };

  const intReviewPage = () => isInt() && location.pathname === "/student/virtual_school/exam_answer.php";
  const choiceLabelIndex = (value) => ["1Aก", "2Bข", "3Cค", "4Dง", "5Eจ"].findIndex(labels => value && labels.includes(value)) + 1;
  const readIntReview = () => {
    const root = document.querySelector("#frm_exam");
    const body = text(root);
    const questionNumber = Number(body.match(/คำถามข้อที่\s*(\d+)/u)?.[1]);
    const correctLabel = body.match(/คำตอบข้อที่ถูก\s*([1-5A-Eกขคงจ])\./u)?.[1];
    const correctChoiceIndex = choiceLabelIndex(correctLabel);
    const code = examCode(root);
    const question = root?.querySelector(".col-md-10.col-md-offset-1");
    const image = question?.querySelector("#imgQ, img");
    const radios = [...(root?.querySelectorAll('input[type="radio"][name="rdoAns"]') || [])];
    const choices = radios.map((radio) => {
      const index = Number(radio.id.match(/\d+$/u)?.[0]);
      const label = document.getElementById(`A${index}`);
      const image = label?.querySelector("img");
      return { index, text: text(label), image: image?.currentSrc || image?.src || null, checked: radio.checked };
    });
    if (!questionNumber || !code || !question || !choices.length || !radios.every((r) => r.disabled) ||
        choices.filter((c) => c.index === correctChoiceIndex).length !== 1) throw new Error("Review question or explicit correct answer is not ready");
    const selected = choices.filter((c) => c.checked);
    if (selected.length > 1) throw new Error("Ambiguous reviewed answer selection");
    const selectedChoiceIndex = selected[0]?.index || null;
    const dialog = intDialog();
    const sheet = dialog && /กระดาษคำตอบ/u.test(text(dialog)) ? [...dialog.querySelectorAll(".btn-next[data_nox]")].map((row) => ({
      questionNumber: Number(row.getAttribute("data_nox")),
      selectedChoiceIndex: choiceLabelIndex(text(row).match(/\)\.\s*([1-5A-Eกขคงจ])\s*$/u)?.[1]) || null,
      correctness: row.classList.contains("danger") ? "incorrect" : row.classList.contains("active") ? "correct" : "unverified",
    })) : [];
    return { questionNumber, totalQuestions: intExamTotal(), examCode: code, questionText: text(question),
      questionImage: image?.currentSrc || image?.src || null, choices, correctChoiceIndex, selectedChoiceIndex,
      correctness: selectedChoiceIndex === correctChoiceIndex ? "correct" : "incorrect",
      verificationSource: "INT explicit correct-answer label", evidence: `คำตอบข้อที่ถูก ${correctLabel}.`, sheet };
  };
  const reviewEpoch = Math.random().toString(36).slice(2);
  let reviewSnapshot = "", reviewSequence = 0;
  const readExamResult = () => {
    const body = text(document.body);
    const resultPage = isInt() ? location.pathname === "/student/virtual_school/exam_result.php" || intReviewPage()
      : location.hostname === "main.virtualschool.club" && (/^\/examanswers\/?$/iu.test(location.pathname) ||
        (/^\/Exam\/?$/iu.test(location.pathname) && /ส่งคำตอบเรียบร้อยแล้ว/u.test(body)));
    if (!resultPage) throw new Error("Open the submitted result or answer-review page first");
    const review = virtualControls().filter((e) => /^(ดูเฉลยคำตอบ|ดูเฉลย|ต้องการดูวิดีโอเฉลย)$/u.test(text(e)));
    const question = intReviewPage() ? readIntReview() : null;
    const score = isInt() && !question ? body.match(/คุณทำ.*?ได้\s*(\d+)\s*ข้อ\s*จากทั้งหมด\s*(\d+)\s*ข้อ/u) : null;
    const status = body.match(/ผลการทดสอบ\s*คือ\s*(ไม่ผ่าน|ผ่าน)/u);
    const snapshot = `${location.href}#${body}`;
    if (snapshot !== reviewSnapshot) { reviewSnapshot = snapshot; reviewSequence++; }
    return { ok: true, url: location.href, resultToken: `${reviewEpoch}:${reviewSequence}`,
      resultText: question ? question.evidence : body, score: score ? { correct: Number(score[1]), total: Number(score[2]), passed: status ? status[1] === "ผ่าน" : null } : null, reviewAvailable: review.length === 1, correctness: "unverified",
      questionImage: null, choices: [], ...question };
  };
  const openAnswerReview = ({ expectedResultToken, step = "open", questionNumber }) => {
    const result = readExamResult();
    if (result.resultToken !== expectedResultToken) throw new Error("Result changed; read it again");
    let target;
    if (step === "open") {
      if (!result.reviewAvailable) throw new Error("A unique answer-review control is not available");
      target = virtualControls().find((e) => /^(ดูเฉลยคำตอบ|ดูเฉลย|ต้องการดูวิดีโอเฉลย)$/u.test(text(e)));
    } else if (intReviewPage() && step === "return") {
      if (intDialog()) throw new Error("Close the review sheet before returning");
      target = document.querySelector("#goback");
    } else if (intReviewPage() && step === "sheet") {
      if (intDialog()) return { ok: true, action: "sheet_already_open" };
      target = document.querySelector(".exam-paper");
    } else if (intReviewPage() && step === "close") {
      const dialog = intDialog();
      if (!dialog || !/กระดาษคำตอบ/u.test(text(dialog))) throw new Error("Review sheet is not open");
      target = dialog.querySelector("button.close");
    } else if (intReviewPage() && (step === "next" || step === "question")) {
      const destination = step === "question" ? questionNumber : result.questionNumber + 1;
      if (step === "next" && result.questionNumber === result.totalQuestions) return { ok: true, done: true };
      if (!Number.isInteger(destination) || destination < 1 || destination > result.totalQuestions) throw new Error("Invalid review question number");
      const dialog = intDialog();
      if (!dialog) {
        target = document.querySelector(".exam-paper");
        if (!visible(target)) throw new Error("Review sheet control unavailable");
        target.click();
        return { ok: true, action: "opened_sheet", done: false };
      }
      if (!/กระดาษคำตอบ/u.test(text(dialog))) throw new Error("Close the unrelated review dialog first");
      const rows = [...dialog.querySelectorAll(".btn-next[data_nox]")].filter((row) =>
        Number(row.getAttribute("data_nox")) === destination);
      if (rows.length === 1) target = rows[0];
    }
    if (!visible(target)) throw new Error("Review navigation control unavailable");
    target.click();
    return { ok: true, action: step === "open" ? "opened_review" : step === "sheet" ? "opened_sheet" : step === "return" ? "returned" : "next", done: false };
  };

  const subjectLinks = () => [...document.querySelectorAll('a.learn[href="check_error.php"][subj][term][level][ranglevel]')].filter(visible);
  const readSubjects = () => {
    if (!isInt() || !intOverview() || intChapterCards().length) throw new Error("Open the INT subject selection page first");
    const subjects = subjectLinks().map((link) => {
      const progressText = text(link.parentElement?.querySelector(".progress-bar"));
      const progress = /^\d+(?:\.\d+)?%$/u.test(progressText) ? Number(progressText.slice(0, -1)) : null;
      const image = link.querySelector("img");
      return { subjectCode: link.getAttribute("subj"), levelId: link.getAttribute("level"),
        termId: link.getAttribute("term"), rangeId: link.getAttribute("ranglevel"),
        name: image?.getAttribute("alt") || image?.getAttribute("title") || null,
        image: image?.currentSrc || image?.src || null,
        progress: progress !== null && progress <= 100 ? progress : null,
        finished: progress === 100 };
    });
    if (!subjects.length || new Set(subjects.map(s => s.subjectCode)).size !== subjects.length ||
        ["levelId", "termId", "rangeId"].some(key => subjects.some(s => !s[key]) || new Set(subjects.map(s => s[key])).size !== 1)) {
      throw new Error("Subject list identity is missing or ambiguous");
    }
    // Opaque DOM IDs are compared verbatim; progress may change after completing a course.
    const listToken = JSON.stringify([location.href, subjects.map(({ subjectCode, levelId, termId, rangeId }) => [subjectCode, levelId, termId, rangeId])]);
    return { origin: pageUrl().origin, listToken, subjects };
  };
  const openSubject = ({ listToken, subjectCode }) => {
    const list = readSubjects();
    if (list.listToken !== listToken) throw new Error("Subject list changed; read_subjects again");
    const subject = list.subjects.find(s => s.subjectCode === subjectCode);
    if (!subject || subject.progress === null || subject.finished) throw new Error("Subject is missing, already finished, or its progress is unknown");
    subjectLinks().find(link => link.getAttribute("subj") === subjectCode).click();
    return { ok: true, action: "opened_subject", subjectCode, next: "Inspect the loaded overview, then set_scope in subject mode with retryUntilPerfect=false" };
  };
  const returnToSubjects = ({ scope }) => {
    assertScope(scope);
    if (!isInt() || !intOverview() || scope.mode !== "subject" || intDialog()) throw new Error("Return to the scoped INT course overview first");
    const links = [...document.querySelectorAll("a.backsubject")].filter(visible);
    if (!links.length || new Set(links.map(link => link.getAttribute("level"))).size !== 1 || !links[0].getAttribute("level")) throw new Error("Subject return control is unavailable or ambiguous");
    links[0].click();
    return { ok: true, action: "returned_to_subjects", next: "Read the subject list again and compare listToken before continuing the saved queue" };
  };

  const inspectPage = () => ({
    path: location.pathname,
    url: location.href,
    origin: pageUrl().origin,
    course: courseIdentity(),
    chapters: chapterCards().map(({ number, title }) => ({ number, title })),
    contentVersion: "0.12.0",
    controls: [...document.querySelectorAll("button, a")]
      .filter((element) => !element.getClientRects || element.getClientRects().length > 0)
      .slice(0, 40)
      .map((element) => ({ label: label(element).slice(0, 160), disabled: !!element.disabled })),
  });

  const advanceSubject = ({ scope }) => {
    const path = location.pathname;
    const result = location.hostname === "main.virtualschool.club" ? advanceVirtualSubject(scope) : advanceIntSubject(scope);
    return { ...result, path, contentVersion: "0.12.0" };
  };

  const submitCurrentExam = (message) => {
    const virtual = location.hostname === "main.virtualschool.club";
    if (virtual ? !/^\/Exam(?:\/|$)/iu.test(location.pathname) : !location.pathname.endsWith("/exam.php")) {
      throw new Error("current page is not a supported exam");
    }
    if (virtual && /ส่งคำตอบเรียบร้อยแล้ว/u.test(text(document.body))) {
      return { ok: true, mode: "result", action: "already_submitted" };
    }
    if (!virtual) return submitIntExam(message);
    assertSubmission(message);
    const dialog = document.querySelector('.swal2-container, [role="dialog"][aria-modal="true"]');
    if (dialog && visible(dialog)) {
      if (/กระดาษคำตอบ/u.test(text(dialog)) && !/ยืนยันการส่งคำตอบ|คุณยังทำข้อสอบไม่ครบ/u.test(text(dialog))) {
        const submit = [...dialog.querySelectorAll("button")].find((element) => visible(element) && text(element) === "ส่งคำตอบ");
        if (!submit) return { ok: true, mode: "submission", action: "waiting" };
        submit.click();
        return { ok: true, mode: "submission", action: "opened" };
      }
      if (!/ยืนยันการส่งคำตอบ|คุณยังทำข้อสอบไม่ครบ/u.test(text(dialog))) throw new Error("Unknown submission dialog; inspect the page");
      const confirm = [...dialog.querySelectorAll("button")].find((element) => visible(element) && text(element) === "ยืนยันการส่ง");
      if (!confirm) return { ok: true, mode: "submission", action: "waiting" };
      confirm.click();
      return { ok: true, mode: "submission", action: "confirmed" };
    }
    const controls = [...document.querySelectorAll("a, button")].filter(visible);
    const submit = controls.find(
      (element) => virtual
        ? /^(?:ส่งคำตอบ(?:ทั้งหมด)?|ส่งข้อสอบ|ส่งแบบทดสอบ|ยืนยันส่งคำตอบ|ยืนยันส่งข้อสอบ)$/u.test(text(element))
        : text(element).includes("ส่งคำตอบทั้งหมด"),
    );
    if (submit) {
      submit.click();
      return { ok: true, mode: "submission", action: "opened" };
    }
    const sheet = virtual && controls.find((element) =>
      /ดูกระดาษคำตอบ/u.test(text(element)) && /ส่งคำตอบ/u.test(text(element)),
    );
    if (!sheet) throw new Error("submit-all control unavailable");
    sheet.click();
    return { ok: true, mode: "submission", action: "opened_sheet" };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (["read_subjects", "open_subject", "return_to_subjects"].includes(message.action)) {
        sendResponse({ ok: true, result: message.action === "read_subjects" ? readSubjects() : message.action === "open_subject" ? openSubject(message) : returnToSubjects(message) });
        return true;
      }
      if (message.action === "bind_current_exam") {
        if (typeof message.examBinding !== "string" || !message.examBinding) throw new Error("Missing exam binding");
        if (!(isInt() && location.pathname === "/student/virtual_school/exam.php") &&
            !(location.hostname === "main.virtualschool.club" && /^\/Exam\/?$/iu.test(location.pathname))) throw new Error("Open an exam question first");
        const question = readQuestion();
        if (question.examCode !== message.expectedExamCode) throw new Error("Stale exam code; read the current question again");
        currentExamBinding = { id: message.examBinding, url: location.href,
          code: location.hostname === "main.virtualschool.club" ? virtualSchoolMetadata().code : null, submissionAllowed: message.allowSubmit === true };
        sendResponse({ ok: true, result: { mode: "exam", origin: pageUrl().origin, examBinding: message.examBinding, submissionAllowed: currentExamBinding.submissionAllowed } });
        return true;
      }
      if (message.action === "read_exam_result" || message.action === "open_answer_review") {
        if (message.scope) assertScope(message.scope);
        sendResponse({ ok: true, result: message.action === "read_exam_result" ? readExamResult() : openAnswerReview(message) });
        return true;
      }
      if (message.scope?.mode === "exam" && !["read_question", "apply_answer", "navigate_next", "inspect_page"].includes(message.action) &&
          !(message.action === "submit_exam" && currentExamBinding?.submissionAllowed === true && message.scope.submissionAllowed === true)) {
        throw new Error("Current-exam scope allows answers only; submission and chapter navigation are disabled");
      }
      if (message.scope || ["apply_answer", "navigate_next", "advance_subject", "submit_exam"].includes(message.action)) assertScope(message.scope);
      const result =
        message.action === "page_version"
          ? { contentVersion: "0.12.0" }
          : message.action === "read_question"
          ? readQuestion()
          : message.action === "apply_answer"
            ? applyAnswer(message)
            : message.action === "navigate_next"
              ? navigateNext(message)
              : message.action === "advance_subject"
                ? advanceSubject(message)
                : message.action === "inspect_page"
                  ? inspectPage()
                : message.action === "submit_exam"
                  ? submitCurrentExam(message)
              : null;
      if (!result) return false;
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  });
})();
