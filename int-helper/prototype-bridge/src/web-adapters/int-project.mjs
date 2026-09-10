import {
  CONTENT_VERSION,
  examCode,
  label,
  pageUrl,
  singleQueryValue,
  text,
  visible,
} from "./content-helpers.mjs";

const INT_HOST = /^(?:www\.)?int-project\.com$/u;
const INT_OVERVIEW = /^\/student\/virtual_school\/(?:index\.php)?$/u;

export const createIntProjectAdapter = ({ document, location }) => {
  let pendingIntSave = null;
  let intVerifiedSheet = null;
  let currentExamBinding = null;
  let reviewSnapshot = "";
  let reviewSequence = 0;
  const reviewEpoch = Math.random().toString(36).slice(2);

  const currentUrl = () => pageUrl(location);
  const currentOrigin = () => currentUrl().origin;

  const intOverview = () => INT_OVERVIEW.test(location.pathname);
  const intDialog = () => [...document.querySelectorAll(".modal.in")].find(visible);

  const readQuestion = () => {
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
      const index = Number(radio.id.match(/\d+$/u)?.[0]) || position + 1;
      const choiceLabel = document.getElementById(`A${index}`);
      const image = choiceLabel?.querySelector("img");
      return { index, text: text(choiceLabel), image: image?.currentSrc || image?.src || null, checked: radio.checked };
    });
    if (!choices.length) throw new Error("answer choices not found");
    const image = question.querySelector("#imgQ, img");
    return {
      ok: true,
      questionNumber: number,
      totalQuestions: intExamTotal(),
      saving: !!pendingIntSave && document.querySelector("#save_exam") === pendingIntSave,
      examCode: code,
      questionText: text(question),
      questionImage: image?.currentSrc || image?.src || null,
      choices,
      done: false,
    };
  };

  const applyAnswer = ({ choiceIndex, expectedExamCode, save }) => {
    const current = readQuestion();
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
    return {
      ok: true,
      examCode: current.examCode,
      selected: Number(choiceIndex),
      saved: null,
      selectionVerified: true,
      saveRequested: true,
      persistence: "unverified_until_submission",
      autoAdvance: true,
      lastQuestion: current.questionNumber === current.totalQuestions,
    };
  };

  const navigateNext = ({ expectedExamCode }) => {
    const root = document.querySelector("#main_quizs");
    const currentExamCode = examCode(root);
    if (!currentExamCode || currentExamCode !== String(expectedExamCode)) throw new Error(`stale exam code: ${currentExamCode || "missing"}`);
    const link = [...document.querySelectorAll("a")].find((element) => text(element) === "ข้อถัดไป");
    if (!link) return { ok: true, done: true };
    setTimeout(() => link.click(), 0);
    return { ok: true, done: false };
  };

  const intCourseIdentity = () => {
    const summary = text(document.querySelector(".retroshadow"));
    const exams = [...document.querySelectorAll('a.exam[examtype="P"][href]')];
    const unique = (key) => {
      const values = new Set(exams.map((element) => element.getAttribute(key)).filter(Boolean));
      return values.size === 1 ? [...values][0] : null;
    };
    const finals = [...document.querySelectorAll('a.exam[examtype="F"]')];
    const final = finals.length === 1 ? finals[0] : null;
    const navigation = final ? {
      levelId: final.getAttribute("level"),
      termId: final.getAttribute("term"),
      rangeId: final.getAttribute("ranglevel"),
    } : null;
    return {
      subjectCode: unique("subj"),
      year: unique("year"),
      navigation,
      level: summary.match(/ปีที่\s*(\d+)/u)?.[1] || null,
      term: summary.match(/ภาคเรียนที่\s*(\d+)/u)?.[1] || null,
      subjectName: summary.match(/วิชา\s*(.+)$/u)?.[1] || null,
    };
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
    const activity = scope.intActivity;
    const identity = scope.navigation;
    if (scope.mode !== "final" || !scope.retryUntilPerfect || activity?.finalResult?.total !== 50 ||
        activity.finalResult.correct >= 50 || !Array.from({ length: 50 }, (_, index) => index + 1).every((number) => activity.reviewedQuestions?.includes(number)) ||
        !identity?.levelId || !identity.termId || !identity.rangeId) return null;
    const screens = [
      ['a.term[href="check_error.php"][level][ranglevel]', [["level", identity.levelId], ["ranglevel", identity.rangeId]], "selected_level"],
      ['a.subject[href="check_error.php"][level][ranglevel][termid]', [["level", identity.levelId], ["ranglevel", identity.rangeId], ["termid", identity.termId]], "selected_term"],
      ['a.learn[href="check_error.php"][subj][term][level][ranglevel]', [["level", identity.levelId], ["ranglevel", identity.rangeId], ["term", identity.termId], ["subj", scope.subjectCode]], "reopened_subject"],
    ];
    for (const [selector, attributes, action] of screens) {
      const candidateControls = [...document.querySelectorAll(selector)].filter(visible);
      if (!candidateControls.length) continue;
      const matches = candidateControls.filter((element) => attributes.every(([key, value]) => element.getAttribute(key) === value));
      if (matches.length !== 1 || matches[0].disabled || matches[0].getAttribute("aria-disabled") === "true" || matches[0].classList.contains("disabled")) {
        throw new Error("Course return controls do not match the scoped level, term and subject");
      }
      return { control: matches[0], action };
    }
    return null;
  };

  const assertScope = (scope) => {
    if (scope?.mode === "exam") {
      if (!currentExamBinding || scope.examBinding !== currentExamBinding.id || location.href !== currentExamBinding.url) {
        throw new Error("Current-exam scope expired; inspect and bind the open exam again");
      }
      return;
    }
    if (!scope || !["chapter", "subject", "final"].includes(scope.mode)) throw new Error("Set an explicit scope before taking actions");
    if (scope.origin !== currentOrigin()) throw new Error("Scoped automation is only verified for int-project.com");
    if (intOverview()) return assertIntOverviewScope(scope);
    const activity = scope.intActivity;
    if (!activity || (scope.mode === "final" && (activity.kind !== "exam" || activity.examType !== "F")) ||
        (activity.examType === "F" && scope.mode === "chapter") ||
        (scope.mode === "chapter" && (activity.chapter !== scope.chapter || activity.title !== scope.chapterTitle))) {
      throw new Error("INT scope requires entering this activity through the scoped overview");
    }
    const params = currentUrl().searchParams;
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
    const heading = review ? `วิชา ${scope.subjectName} หน่วยการเรียนรู้ที่ ${activity.chapter} ภาคเรียนที่ ${scope.term}` : final ? `${type} วิชา ${scope.subjectName}${result ? "" : ` ภาคเรียนที่ ${scope.term}`} ` : result
      ? `${type} วิชา ${scope.subjectName} หน่วยการเรียนรู้ ${activity.title}`
      : `${type} วิชา ${scope.subjectName} หน่วยการเรียนรู้ที่ ${activity.chapter} ${activity.title} ภาคเรียนที่ ${scope.term}`;
    if (review && (!body.includes(`เฉลยคำตอบ ${type}`) || (final && !body.replace(/\s+/gu, "").includes(`วิชา${scope.subjectName}ภาคเรียนที่${scope.term}`.replace(/\s+/gu, ""))))) throw new Error("INT review heading does not match scope");
    if (!(review && final) && !body.replace(/\s+/gu, "").includes(heading.replace(/\s+/gu, ""))) throw new Error("INT exam heading does not match the scoped activity");
  };

  const assertIntOverviewScope = (scope) => {
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
    const matches = cards.filter((card) => card.number === scope.chapter);
    if (scope.mode === "chapter" && (matches.length !== 1 || matches[0].title !== scope.chapterTitle || cards.filter((card) => card.title === scope.chapterTitle).length !== 1)) {
      throw new Error("Target chapter cannot be identified");
    }
  };

  const reviewRequired = (scope) => scope.retryUntilPerfect && scope.intActivity?.finalResult?.correct !== 50 &&
    Array.from({ length: 50 }, (_, index) => index + 1).some((number) => !scope.intActivity?.reviewedQuestions?.includes(number));

  const advanceSubject = (scope) => {
    if (location.pathname === "/student/virtual_school/exam_answer.php") {
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
      return Date.now() - scope.intActivity.enteredAt < 5000 ? { ok: true, mode: "overview", action: "waiting" } :
        { ok: true, mode: "scope_boundary", reason: "The website did not open the final exam; retake may be unavailable" };
    }
    const cards = intChapterCards().filter((card) => scope.mode !== "final" && (scope.mode === "subject" || card.number === scope.chapter));
    for (const { card, number, title } of cards) {
      const activities = [...card.querySelectorAll('a[examtype], a.learn')];
      const complete = activities.length >= 3 && activities.every((activity) => [...activity.querySelectorAll('svg[data-icon="circle"]')].some((icon) => /color:\s*(?:#32cd32|rgb\(50,\s*205,\s*50\))/iu.test(icon.getAttribute("style") || "")));
      if (complete) {
        if (scope.mode === "chapter") return { ok: true, mode: "chapter_complete", chapter: number };
        continue;
      }
      const next = activities.find((activity) => activity.getAttribute("href") === "check_error.php" && activity.querySelector('img[src*="yellow.gif"]'));
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
    if (final.getAttribute("subj") !== scope.subjectCode || final.getAttribute("year") !== scope.year) throw new Error("INT final exam link does not match scope");
    const completedFinal = [...final.querySelectorAll('svg[data-icon="circle"]')].some((icon) => /color:\s*(?:#32cd32|rgb\(50,\s*205,\s*50\))/iu.test(icon.getAttribute("style") || ""));
    if (scope.mode === "subject" && completedFinal) return { ok: true, mode: "complete", alreadyFinished: true };
    const normalRetake = scope.mode === "final" && completedFinal && !scope.intActivity?.finalResult;
    if (!visible(final) || final.disabled || final.getAttribute("aria-disabled") === "true" || final.classList.contains("disabled") || final.getAttribute("href") !== "check_error.php" ||
        (!final.querySelector('img[src*="yellow.gif"]') && !normalRetake && !(scope.retryUntilPerfect && (!scope.intActivity?.finalResult || !reviewRequired(scope))))) {
      return { ok: true, mode: "scope_boundary", reason: "INT final exam is not available" };
    }
    final.click();
    return { ok: true, mode: "overview", action: "opened", activity: text(final), intActivity: { kind: "exam", examType: "F", attempt: (scope.intActivity?.attempt || 0) + 1, enteredAt: Date.now() } };
  };

  const submitCurrentExam = ({ expectedExamCode, scope }) => {
    const current = readQuestion();
    if (current.examCode !== expectedExamCode) throw new Error(`stale exam code: ${current.examCode}`);
    if (current.saving) throw new Error("Wait for the pending answer save before submission");
    const emptyAllowed = scope.allowEmptyPretest === true && scope.mode !== "exam" && scope.intActivity?.examType === "P";
    const dialog = intDialog();
    if (dialog) {
      const body = text(dialog);
      if (/กระดาษคำตอบ/u.test(body)) {
        intVerifiedSheet = null;
        const rows = [...dialog.querySelectorAll("a.tl[quesid]")];
        const answers = new Map(rows.map((row) => [Number(row.getAttribute("quesid")), text(row.querySelector(".badge"))]));
        if (rows.length !== current.totalQuestions || answers.size !== current.totalQuestions ||
            Array.from({ length: current.totalQuestions }, (_, index) => index + 1).some((number) => !/^[A-E1-5กขคงจ]$/u.test(answers.get(number) || ""))) {
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

  const intReviewPage = () => location.pathname === "/student/virtual_school/exam_answer.php";
  const choiceLabelIndex = (value) => ["1Aก", "2Bข", "3Cค", "4Dง", "5Eจ"].findIndex((labels) => value && labels.includes(value)) + 1;

  const readReview = () => {
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
      const choiceLabel = document.getElementById(`A${index}`);
      const choiceImage = choiceLabel?.querySelector("img");
      return { index, text: text(choiceLabel), image: choiceImage?.currentSrc || choiceImage?.src || null, checked: radio.checked };
    });
    if (!questionNumber || !code || !question || !choices.length || !radios.every((radio) => radio.disabled) || choices.filter((choice) => choice.index === correctChoiceIndex).length !== 1) {
      throw new Error("Review question or explicit correct answer is not ready");
    }
    const selected = choices.filter((choice) => choice.checked);
    if (selected.length > 1) throw new Error("Ambiguous reviewed answer selection");
    const selectedChoiceIndex = selected[0]?.index || null;
    const dialog = intDialog();
    const sheet = dialog && /กระดาษคำตอบ/u.test(text(dialog)) ? [...dialog.querySelectorAll(".btn-next[data_nox]")].map((row) => ({
      questionNumber: Number(row.getAttribute("data_nox")),
      selectedChoiceIndex: choiceLabelIndex(text(row).match(/\)\.\s*([1-5A-Eกขคงจ])\s*$/u)?.[1]) || null,
      correctness: row.classList.contains("danger") ? "incorrect" : row.classList.contains("active") ? "correct" : "unverified",
    })) : [];
    return {
      questionNumber,
      totalQuestions: intExamTotal(),
      examCode: code,
      questionText: text(question),
      questionImage: image?.currentSrc || image?.src || null,
      choices,
      correctChoiceIndex,
      selectedChoiceIndex,
      correctness: selectedChoiceIndex === correctChoiceIndex ? "correct" : "incorrect",
      verificationSource: "INT explicit correct-answer label",
      evidence: `คำตอบข้อที่ถูก ${correctLabel}.`,
      sheet,
    };
  };

  const readExamResult = () => {
    const body = text(document.body);
    const resultPage = location.pathname === "/student/virtual_school/exam_result.php" || intReviewPage();
    if (!resultPage) throw new Error("Open the submitted result or answer-review page first");
    const question = intReviewPage() ? readReview() : null;
    const score = !question ? body.match(/คุณทำ.*?ได้\s*(\d+)\s*ข้อ\s*จากทั้งหมด\s*(\d+)\s*ข้อ/u) : null;
    const status = body.match(/ผลการทดสอบ\s*คือ\s*(ไม่ผ่าน|ผ่าน)/u);
    const snapshot = `${location.href}#${body}`;
    if (snapshot !== reviewSnapshot) {
      reviewSnapshot = snapshot;
      reviewSequence += 1;
    }
    return {
      ok: true,
      url: location.href,
      resultToken: `${reviewEpoch}:${reviewSequence}`,
      resultText: question ? question.evidence : body,
      score: score ? { correct: Number(score[1]), total: Number(score[2]), passed: status ? status[1] === "ผ่าน" : null } : null,
      reviewAvailable: false,
      correctness: "unverified",
      questionImage: null,
      choices: [],
      ...question,
    };
  };

  const openAnswerReview = ({ expectedResultToken, step = "open", questionNumber }) => {
    const result = readExamResult();
    if (result.resultToken !== expectedResultToken) throw new Error("Result changed; read it again");
    let target;
    if (step === "return" && intReviewPage()) {
      if (intDialog()) throw new Error("Close the review sheet before returning");
      target = document.querySelector("#goback");
    } else if (step === "sheet" && intReviewPage()) {
      if (intDialog()) return { ok: true, action: "sheet_already_open" };
      target = document.querySelector(".exam-paper");
    } else if (step === "close" && intReviewPage()) {
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
      const rows = [...dialog.querySelectorAll(".btn-next[data_nox]")].filter((row) => Number(row.getAttribute("data_nox")) === destination);
      if (rows.length === 1) target = rows[0];
    } else if (step === "open") {
      throw new Error("INT answer-review control is not available on this result page");
    } else {
      throw new Error("Review navigation control unavailable");
    }
    if (!visible(target)) throw new Error("Review navigation control unavailable");
    target.click();
    return { ok: true, action: step === "sheet" ? "opened_sheet" : step === "return" ? "returned" : "next", done: false };
  };

  const subjectLinks = () => [...document.querySelectorAll('a.learn[href="check_error.php"][subj][term][level][ranglevel]')].filter(visible);

  const readSubjects = () => {
    if (!intOverview() || intChapterCards().length) throw new Error("Open the INT subject selection page first");
    const subjects = subjectLinks().map((link) => {
      const progressText = text(link.parentElement?.querySelector(".progress-bar"));
      const progress = /^\d+(?:\.\d+)?%$/u.test(progressText) ? Number(progressText.slice(0, -1)) : null;
      const image = link.querySelector("img");
      return {
        subjectCode: link.getAttribute("subj"),
        levelId: link.getAttribute("level"),
        termId: link.getAttribute("term"),
        rangeId: link.getAttribute("ranglevel"),
        name: image?.getAttribute("alt") || image?.getAttribute("title") || null,
        image: image?.currentSrc || image?.src || null,
        progress: progress !== null && progress <= 100 ? progress : null,
        finished: progress === 100,
      };
    });
    if (!subjects.length || new Set(subjects.map((subject) => subject.subjectCode)).size !== subjects.length ||
        ["levelId", "termId", "rangeId"].some((key) => subjects.some((subject) => !subject[key]) || new Set(subjects.map((subject) => subject[key])).size !== 1)) {
      throw new Error("Subject list identity is missing or ambiguous");
    }
    const listToken = JSON.stringify([location.href, subjects.map(({ subjectCode, levelId, termId, rangeId }) => [subjectCode, levelId, termId, rangeId])]);
    return { origin: currentOrigin(), listToken, subjects };
  };

  const openSubject = ({ listToken, subjectCode }) => {
    const list = readSubjects();
    if (list.listToken !== listToken) throw new Error("Subject list changed; read_subjects again");
    const subject = list.subjects.find((candidate) => candidate.subjectCode === subjectCode);
    if (!subject || subject.progress === null || subject.finished) throw new Error("Subject is missing, already finished, or its progress is unknown");
    const link = subjectLinks().find((candidate) => candidate.getAttribute("subj") === subjectCode);
    if (!visible(link)) throw new Error("Subject link is unavailable or stale; read_subjects again");
    link.click();
    return { ok: true, action: "opened_subject", subjectCode, next: "Inspect the loaded overview, then set normal subject scope with retryUntilPerfect=false" };
  };

  const returnToSubjects = ({ scope }) => {
    assertScope(scope);
    if (!intOverview() || scope.mode !== "subject" || intDialog()) throw new Error("Return to the scoped INT course overview first");
    const links = [...document.querySelectorAll("a.backsubject")].filter(visible);
    if (!links.length || new Set(links.map((link) => link.getAttribute("level"))).size !== 1 || !links[0].getAttribute("level")) throw new Error("Subject return control is unavailable or ambiguous");
    links[0].click();
    return { ok: true, action: "returned_to_subjects", next: "Read the subject list again and compare listToken before continuing the saved queue" };
  };

  const inspectPage = () => ({
    path: location.pathname,
    url: location.href,
    origin: currentOrigin(),
    course: intCourseIdentity(),
    chapters: intChapterCards().map(({ number, title }) => ({ number, title })),
    contentVersion: CONTENT_VERSION,
    controls: [...document.querySelectorAll("button, a")]
      .filter((element) => !element.getClientRects || element.getClientRects().length > 0)
      .slice(0, 40)
      .map((element) => ({ label: label(element).slice(0, 160), disabled: !!element.disabled })),
  });

  const bindCurrentExam = ({ examBinding, expectedExamCode, allowSubmit }) => {
    if (typeof examBinding !== "string" || !examBinding) throw new Error("Missing exam binding");
    if (location.pathname !== "/student/virtual_school/exam.php") throw new Error("Open an exam question first");
    const question = readQuestion();
    if (question.examCode !== expectedExamCode) throw new Error("Stale exam code; read the current question again");
    currentExamBinding = { id: examBinding, url: location.href, code: null, submissionAllowed: allowSubmit === true };
    return { mode: "exam", origin: currentOrigin(), examBinding, submissionAllowed: currentExamBinding.submissionAllowed };
  };

  const supports = (locationLike = location) => INT_HOST.test(locationLike.hostname);

  const handle = (action, message = {}) => {
    if (action === "page_version") return { contentVersion: CONTENT_VERSION };
    if (action === "read_subjects") return readSubjects();
    if (action === "open_subject") return openSubject(message);
    if (action === "return_to_subjects") return returnToSubjects(message);
    if (action === "bind_current_exam") return bindCurrentExam(message);
    if (action === "read_exam_result") {
      if (message.scope) assertScope(message.scope);
      return readExamResult();
    }
    if (action === "open_answer_review") {
      if (message.scope) assertScope(message.scope);
      return openAnswerReview(message);
    }
    if (message.scope?.mode === "exam" && !["read_question", "apply_answer", "navigate_next", "inspect_page"].includes(action) &&
        !(action === "submit_exam" && currentExamBinding?.submissionAllowed === true && message.scope.submissionAllowed === true)) {
      throw new Error("Current-exam scope allows answers only; submission and chapter navigation are disabled");
    }
    if (message.scope || ["apply_answer", "navigate_next", "advance_subject", "submit_exam"].includes(action)) assertScope(message.scope);
    if (action === "read_question") return readQuestion();
    if (action === "apply_answer") return applyAnswer(message);
    if (action === "navigate_next") return navigateNext(message);
    if (action === "advance_subject") return advanceSubject(message.scope);
    if (action === "inspect_page") return inspectPage();
    if (action === "submit_exam") return submitCurrentExam(message);
    return null;
  };

  return { supports, inspect: inspectPage, handle };
};
