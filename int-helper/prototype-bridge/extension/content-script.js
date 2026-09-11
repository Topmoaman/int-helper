(() => {
  // src/web-adapters/content-helpers.mjs
  var text = (element) => (element?.innerText || "").replace(/\s+/gu, " ").trim();
  var CONTENT_VERSION = "0.15.0";
  var label = (element) => [element?.getAttribute?.("aria-label"), text(element), element?.title].filter(Boolean).join(" ");
  var visible = (element) => element && !element.disabled && (!element.getClientRects || element.getClientRects().length > 0);
  var pageUrl = (locationLike = globalThis.location) => new URL(locationLike.href);
  var singleQueryValue = (params, key) => {
    const values = params.getAll(key).filter(Boolean);
    if (new Set(values).size > 1) throw new Error(`Conflicting ${key} parameters`);
    return values[0] || null;
  };
  var aliasQueryValue = (params, keys, name) => {
    const values = keys.flatMap((key) => params.getAll(key).filter(Boolean));
    if (new Set(values).size > 1) throw new Error(`Conflicting ${name} identifiers`);
    return values[0] || null;
  };
  var examCode = (root, bodyText = text(root)) => bodyText.match(/รหัสข้อสอบ\s*:\s*([^\s|]+)/u)?.[1] || null;

  // src/web-adapters/int-project.mjs
  var INT_HOST = /^(?:www\.)?int-project\.com$/u;
  var INT_OVERVIEW = /^\/student\/virtual_school\/(?:index\.php)?$/u;
  var createIntProjectAdapter = ({ document: document2, location: location2 }) => {
    let pendingIntSave = null;
    let intVerifiedSheet = null;
    let currentExamBinding = null;
    let reviewSnapshot = "";
    let reviewSequence = 0;
    const reviewEpoch = Math.random().toString(36).slice(2);
    const currentUrl = () => pageUrl(location2);
    const currentOrigin = () => currentUrl().origin;
    const intOverview = () => INT_OVERVIEW.test(location2.pathname);
    const intDialog = () => [...document2.querySelectorAll(".modal.in")].find(visible);
    const readQuestion = () => {
      const root = document2.querySelector("#main_quizs");
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
        const choiceLabel = document2.getElementById(`A${index}`);
        const image2 = choiceLabel?.querySelector("img");
        return { index, text: text(choiceLabel), image: image2?.currentSrc || image2?.src || null, checked: radio.checked };
      });
      if (!choices.length) throw new Error("answer choices not found");
      const image = question.querySelector("#imgQ, img");
      return {
        ok: true,
        questionNumber: number,
        totalQuestions: intExamTotal(),
        saving: !!pendingIntSave && document2.querySelector("#save_exam") === pendingIntSave,
        examCode: code,
        questionText: text(question),
        questionImage: image?.currentSrc || image?.src || null,
        choices,
        done: false
      };
    };
    const applyAnswer = ({ choiceIndex, expectedExamCode, save }) => {
      const current = readQuestion();
      if (current.examCode !== String(expectedExamCode)) throw new Error(`stale exam code: ${current.examCode}`);
      if (save !== true) throw new Error("INT Project requires save=true: its Save button persists the answer and advances automatically");
      if (intDialog()) throw new Error("Close the current INT dialog before answering");
      const button = document2.querySelector("#save_exam");
      if (!visible(button) || current.saving) throw new Error("save button unavailable or previous save is pending");
      const radio = document2.querySelector(`#rdoAns${Number(choiceIndex)}`);
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
        lastQuestion: current.questionNumber === current.totalQuestions
      };
    };
    const navigateNext = ({ expectedExamCode }) => {
      const root = document2.querySelector("#main_quizs");
      const currentExamCode = examCode(root);
      if (!currentExamCode || currentExamCode !== String(expectedExamCode)) throw new Error(`stale exam code: ${currentExamCode || "missing"}`);
      const link = [...document2.querySelectorAll("a")].find((element) => text(element) === "\u0E02\u0E49\u0E2D\u0E16\u0E31\u0E14\u0E44\u0E1B");
      if (!link) return { ok: true, done: true };
      setTimeout(() => link.click(), 0);
      return { ok: true, done: false };
    };
    const intCourseIdentity = () => {
      const summary = text(document2.querySelector(".retroshadow"));
      const exams = [...document2.querySelectorAll('a.exam[examtype="P"][href]')];
      const unique = (key) => {
        const values = new Set(exams.map((element) => element.getAttribute(key)).filter(Boolean));
        return values.size === 1 ? [...values][0] : null;
      };
      const finals = [...document2.querySelectorAll('a.exam[examtype="F"]')];
      const final = finals.length === 1 ? finals[0] : null;
      const navigation = final ? {
        levelId: final.getAttribute("level"),
        termId: final.getAttribute("term"),
        rangeId: final.getAttribute("ranglevel")
      } : null;
      return {
        subjectCode: unique("subj"),
        year: unique("year"),
        navigation,
        level: summary.match(/ปีที่\s*(\d+)/u)?.[1] || null,
        term: summary.match(/ภาคเรียนที่\s*(\d+)/u)?.[1] || null,
        subjectName: summary.match(/วิชา\s*(.+)$/u)?.[1] || null
      };
    };
    const intChapterCards = () => [...document2.querySelectorAll(".panel-warning")].map((card) => {
      const header = card.querySelector(":scope > .panel-heading");
      const match = text(header).match(/^หน่วยการเรียนรู้ที่\s*(\d+)\s+(.+)$/u);
      return { card, header, number: Number(match?.[1]), title: match?.[2] || "" };
    }).filter(({ number }) => number > 0);
    const intExamTotal = () => {
      const total = Number(text(document2.body).match(/จำนวนข้อสอบ\s*(\d+)\s*ข้อ/u)?.[1]);
      if (!total || total > 1e3) throw new Error("INT exam total is missing or invalid");
      return total;
    };
    const scopedReturnTarget = (scope) => {
      const activity = scope.intActivity;
      const identity = scope.navigation;
      if (scope.mode !== "final" || !scope.retryUntilPerfect || activity?.finalResult?.total !== 50 || activity.finalResult.correct >= 50 || !Array.from({ length: 50 }, (_, index) => index + 1).every((number) => activity.reviewedQuestions?.includes(number)) || !identity?.levelId || !identity.termId || !identity.rangeId) return null;
      const screens = [
        ['a.term[href="check_error.php"][level][ranglevel]', [["level", identity.levelId], ["ranglevel", identity.rangeId]], "selected_level"],
        ['a.subject[href="check_error.php"][level][ranglevel][termid]', [["level", identity.levelId], ["ranglevel", identity.rangeId], ["termid", identity.termId]], "selected_term"],
        ['a.learn[href="check_error.php"][subj][term][level][ranglevel]', [["level", identity.levelId], ["ranglevel", identity.rangeId], ["term", identity.termId], ["subj", scope.subjectCode]], "reopened_subject"]
      ];
      for (const [selector, attributes, action] of screens) {
        const candidateControls = [...document2.querySelectorAll(selector)].filter(visible);
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
        if (!currentExamBinding || scope.examBinding !== currentExamBinding.id || location2.href !== currentExamBinding.url) {
          throw new Error("Current-exam scope expired; inspect and bind the open exam again");
        }
        return;
      }
      if (!scope || !["chapter", "subject", "final"].includes(scope.mode)) throw new Error("Set an explicit scope before taking actions");
      if (scope.origin !== currentOrigin()) throw new Error("Scoped automation is only verified for int-project.com");
      if (intOverview()) return assertIntOverviewScope(scope);
      const activity = scope.intActivity;
      if (!activity || scope.mode === "final" && (activity.kind !== "exam" || activity.examType !== "F") || activity.examType === "F" && scope.mode === "chapter" || scope.mode === "chapter" && (activity.chapter !== scope.chapter || activity.title !== scope.chapterTitle)) {
        throw new Error("INT scope requires entering this activity through the scoped overview");
      }
      const params = currentUrl().searchParams;
      if (/^\/student\/virtual_school\/content\/(?:index\.php)?$/u.test(location2.pathname)) {
        if (activity.kind !== "lesson" || ["content", "term", "level", "rang", "linelearn"].some((key) => !activity.params[key] || params.get(key) !== activity.params[key])) throw new Error("Lesson is outside the requested INT scope");
        return;
      }
      const result = location2.pathname === "/student/virtual_school/exam_result.php";
      const review = location2.pathname === "/student/virtual_school/exam_answer.php";
      if (!result && !review && location2.pathname !== "/student/virtual_school/exam.php") throw new Error("Page is outside the supported scoped routes");
      if (activity.kind !== "exam" || !["P", "A", "F"].includes(activity.examType)) throw new Error("Exam is outside the requested INT scope");
      const body = text(document2.body);
      if (scope.retryUntilPerfect && !result && intExamTotal() !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
      const final = activity.examType === "F";
      const type = final ? "\u0E41\u0E1A\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E1B\u0E25\u0E32\u0E22\u0E20\u0E32\u0E04" : activity.examType === "P" ? "\u0E41\u0E1A\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E01\u0E48\u0E2D\u0E19\u0E40\u0E23\u0E35\u0E22\u0E19" : "\u0E41\u0E1A\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E2B\u0E25\u0E31\u0E07\u0E40\u0E23\u0E35\u0E22\u0E19";
      const heading = review ? `\u0E27\u0E34\u0E0A\u0E32 ${scope.subjectName} \u0E2B\u0E19\u0E48\u0E27\u0E22\u0E01\u0E32\u0E23\u0E40\u0E23\u0E35\u0E22\u0E19\u0E23\u0E39\u0E49\u0E17\u0E35\u0E48 ${activity.chapter} \u0E20\u0E32\u0E04\u0E40\u0E23\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48 ${scope.term}` : final ? `${type} \u0E27\u0E34\u0E0A\u0E32 ${scope.subjectName}${result ? "" : ` \u0E20\u0E32\u0E04\u0E40\u0E23\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48 ${scope.term}`} ` : result ? `${type} \u0E27\u0E34\u0E0A\u0E32 ${scope.subjectName} \u0E2B\u0E19\u0E48\u0E27\u0E22\u0E01\u0E32\u0E23\u0E40\u0E23\u0E35\u0E22\u0E19\u0E23\u0E39\u0E49 ${activity.title}` : `${type} \u0E27\u0E34\u0E0A\u0E32 ${scope.subjectName} \u0E2B\u0E19\u0E48\u0E27\u0E22\u0E01\u0E32\u0E23\u0E40\u0E23\u0E35\u0E22\u0E19\u0E23\u0E39\u0E49\u0E17\u0E35\u0E48 ${activity.chapter} ${activity.title} \u0E20\u0E32\u0E04\u0E40\u0E23\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48 ${scope.term}`;
      if (review && (!body.includes(`\u0E40\u0E09\u0E25\u0E22\u0E04\u0E33\u0E15\u0E2D\u0E1A ${type}`) || final && !body.replace(/\s+/gu, "").includes(`\u0E27\u0E34\u0E0A\u0E32${scope.subjectName}\u0E20\u0E32\u0E04\u0E40\u0E23\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48${scope.term}`.replace(/\s+/gu, "")))) throw new Error("INT review heading does not match scope");
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
    const reviewRequired = (scope) => scope.retryUntilPerfect && scope.intActivity?.finalResult?.correct !== 50 && Array.from({ length: 50 }, (_, index) => index + 1).some((number) => !scope.intActivity?.reviewedQuestions?.includes(number));
    const advanceSubject = (scope) => {
      if (location2.pathname === "/student/virtual_school/exam_answer.php") {
        if (reviewRequired(scope)) return { ok: true, mode: "review_required", reviewed: scope.intActivity.reviewedQuestions?.length || 0 };
        const back = document2.querySelector("#goback");
        if (!visible(back)) return { ok: true, mode: "result", action: "waiting" };
        back.click();
        return { ok: true, mode: "result", action: "returned" };
      }
      if (location2.pathname.endsWith("/exam_result.php")) {
        const back = document2.querySelector(".backplan");
        if (!visible(back)) return { ok: true, mode: "result", action: "waiting" };
        if (scope.intActivity.examType === "F") {
          const body = text(document2.body);
          const score = body.match(/คุณทำแบบทดสอบปลายภาค ได้ (\d+) ข้อ จากทั้งหมด (\d+) ข้อ/u);
          const status = body.match(/ผลการทดสอบ คือ (ไม่ผ่าน|ผ่าน)/u);
          if (!score || !status) return { ok: true, mode: "result", action: "waiting" };
          const finalResult = { correct: Number(score[1]), total: Number(score[2]), passed: status[1] === "\u0E1C\u0E48\u0E32\u0E19" };
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
      if (location2.pathname.endsWith("/exam.php")) {
        if (dialog) return { ok: true, mode: "submission", action: "confirmation_required" };
        if (!document2.querySelector('#main_quizs input[name="rdoAns"]')) return { ok: true, mode: "exam", ready: false, action: "waiting" };
        const pretest = scope.intActivity.examType === "P";
        return { ok: true, mode: "exam", pretest, needsAnswers: !(pretest && scope.allowEmptyPretest === true) };
      }
      if (location2.pathname.includes("/virtual_school/content/")) {
        if (dialog) {
          const confirm = dialog.querySelector("button.confirm-save-learn");
          if (visible(confirm) && /ต้องการออกจากบทเรียนนี้/u.test(text(dialog))) {
            confirm.click();
            return { ok: true, mode: "lesson", action: "confirmed" };
          }
          return { ok: true, mode: "lesson", action: "waiting" };
        }
        const save = document2.querySelector("button.save-learn");
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
        if (!scope.retryUntilPerfect || score.total === 50 && score.correct === 50) return { ok: true, mode: "complete", finalResult: score };
        if (score.total !== 50) throw new Error("Perfect-score looping requires exactly 50 questions");
        if (reviewRequired(scope)) return { ok: true, mode: "review_required", reviewed: scope.intActivity.reviewedQuestions?.length || 0 };
      }
      if (scope.intActivity?.enteredAt && !scope.intActivity.finalResult) {
        return Date.now() - scope.intActivity.enteredAt < 5e3 ? { ok: true, mode: "overview", action: "waiting" } : { ok: true, mode: "scope_boundary", reason: "The website did not open the final exam; retake may be unavailable" };
      }
      const cards = intChapterCards().filter((card) => scope.mode !== "final" && (scope.mode === "subject" || card.number === scope.chapter));
      for (const { card, number, title } of cards) {
        const activities = [...card.querySelectorAll("a[examtype], a.learn")];
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
          if (!["P", "A"].includes(intActivity.examType) || Number(next.getAttribute("idlearn")) !== number || next.getAttribute("subj") !== scope.subjectCode || next.getAttribute("year") !== scope.year) throw new Error("INT exam link does not match scope");
        }
        next.click();
        return { ok: true, mode: "overview", action: "opened", chapter: number, activity: text(next), intActivity };
      }
      if (scope.mode === "chapter") return { ok: true, mode: "scope_boundary", reason: "Requested chapter is unavailable" };
      const finals = [...document2.querySelectorAll('a.exam[examtype="F"]')];
      if (finals.length !== 1) throw new Error("INT final exam is not uniquely identified");
      const final = finals[0];
      if (final.getAttribute("subj") !== scope.subjectCode || final.getAttribute("year") !== scope.year) throw new Error("INT final exam link does not match scope");
      const completedFinal = [...final.querySelectorAll('svg[data-icon="circle"]')].some((icon) => /color:\s*(?:#32cd32|rgb\(50,\s*205,\s*50\))/iu.test(icon.getAttribute("style") || ""));
      if (scope.mode === "subject" && completedFinal) return { ok: true, mode: "complete", alreadyFinished: true };
      const normalRetake = scope.mode === "final" && completedFinal && !scope.intActivity?.finalResult;
      if (!visible(final) || final.disabled || final.getAttribute("aria-disabled") === "true" || final.classList.contains("disabled") || final.getAttribute("href") !== "check_error.php" || !final.querySelector('img[src*="yellow.gif"]') && !normalRetake && !(scope.retryUntilPerfect && (!scope.intActivity?.finalResult || !reviewRequired(scope)))) {
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
          if (rows.length !== current.totalQuestions || answers.size !== current.totalQuestions || Array.from({ length: current.totalQuestions }, (_, index) => index + 1).some((number) => !/^[A-E1-5กขคงจ]$/u.test(answers.get(number) || ""))) {
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
      const button = document2.querySelector(sheetNeeded ? "#ansedit" : "#anssend");
      if (!visible(button)) throw new Error("INT submission control unavailable");
      button.click();
      return { ok: true, mode: "submission", action: sheetNeeded ? "opened_sheet" : "opened" };
    };
    const intReviewPage = () => location2.pathname === "/student/virtual_school/exam_answer.php";
    const choiceLabelIndex = (value) => ["1A\u0E01", "2B\u0E02", "3C\u0E04", "4D\u0E07", "5E\u0E08"].findIndex((labels) => value && labels.includes(value)) + 1;
    const readReview = () => {
      const root = document2.querySelector("#frm_exam");
      const body = text(root);
      const questionNumber = Number(body.match(/คำถามข้อที่\s*(\d+)/u)?.[1]);
      const correctLabel = body.match(/คำตอบข้อที่ถูก\s*([1-5A-Eกขคงจ])\./u)?.[1];
      const correctChoiceIndex = choiceLabelIndex(correctLabel);
      const code = examCode(root);
      const question = root?.querySelector(".col-md-10.col-md-offset-1");
      const image = question?.querySelector("#imgQ, img");
      const radios = [...root?.querySelectorAll('input[type="radio"][name="rdoAns"]') || []];
      const choices = radios.map((radio) => {
        const index = Number(radio.id.match(/\d+$/u)?.[0]);
        const choiceLabel = document2.getElementById(`A${index}`);
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
        correctness: row.classList.contains("danger") ? "incorrect" : row.classList.contains("active") ? "correct" : "unverified"
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
        evidence: `\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E02\u0E49\u0E2D\u0E17\u0E35\u0E48\u0E16\u0E39\u0E01 ${correctLabel}.`,
        sheet
      };
    };
    const readExamResult = () => {
      const body = text(document2.body);
      const resultPage = location2.pathname === "/student/virtual_school/exam_result.php" || intReviewPage();
      if (!resultPage) throw new Error("Open the submitted result or answer-review page first");
      const question = intReviewPage() ? readReview() : null;
      const score = !question ? body.match(/คุณทำ.*?ได้\s*(\d+)\s*ข้อ\s*จากทั้งหมด\s*(\d+)\s*ข้อ/u) : null;
      const status = body.match(/ผลการทดสอบ\s*คือ\s*(ไม่ผ่าน|ผ่าน)/u);
      const snapshot = `${location2.href}#${body}`;
      if (snapshot !== reviewSnapshot) {
        reviewSnapshot = snapshot;
        reviewSequence += 1;
      }
      return {
        ok: true,
        url: location2.href,
        resultToken: `${reviewEpoch}:${reviewSequence}`,
        resultText: question ? question.evidence : body,
        score: score ? { correct: Number(score[1]), total: Number(score[2]), passed: status ? status[1] === "\u0E1C\u0E48\u0E32\u0E19" : null } : null,
        reviewAvailable: false,
        correctness: "unverified",
        questionImage: null,
        choices: [],
        ...question
      };
    };
    const openAnswerReview = ({ expectedResultToken, step = "open", questionNumber }) => {
      const result = readExamResult();
      if (result.resultToken !== expectedResultToken) throw new Error("Result changed; read it again");
      let target;
      if (step === "return" && intReviewPage()) {
        if (intDialog()) throw new Error("Close the review sheet before returning");
        target = document2.querySelector("#goback");
      } else if (step === "sheet" && intReviewPage()) {
        if (intDialog()) return { ok: true, action: "sheet_already_open" };
        target = document2.querySelector(".exam-paper");
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
          target = document2.querySelector(".exam-paper");
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
    const subjectLinks = () => [...document2.querySelectorAll('a.learn[href="check_error.php"][subj][term][level][ranglevel]')].filter(visible);
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
          finished: progress === 100
        };
      });
      if (!subjects.length || new Set(subjects.map((subject) => subject.subjectCode)).size !== subjects.length || ["levelId", "termId", "rangeId"].some((key) => subjects.some((subject) => !subject[key]) || new Set(subjects.map((subject) => subject[key])).size !== 1)) {
        throw new Error("Subject list identity is missing or ambiguous");
      }
      const listToken = JSON.stringify([location2.href, subjects.map(({ subjectCode, levelId, termId, rangeId }) => [subjectCode, levelId, termId, rangeId])]);
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
      const links = [...document2.querySelectorAll("a.backsubject")].filter(visible);
      if (!links.length || new Set(links.map((link) => link.getAttribute("level"))).size !== 1 || !links[0].getAttribute("level")) throw new Error("Subject return control is unavailable or ambiguous");
      links[0].click();
      return { ok: true, action: "returned_to_subjects", next: "Read the subject list again and compare listToken before continuing the saved queue" };
    };
    const inspectPage = () => ({
      path: location2.pathname,
      url: location2.href,
      origin: currentOrigin(),
      course: intCourseIdentity(),
      chapters: intChapterCards().map(({ number, title }) => ({ number, title })),
      contentVersion: CONTENT_VERSION,
      controls: [...document2.querySelectorAll("button, a")].filter((element) => !element.getClientRects || element.getClientRects().length > 0).slice(0, 40).map((element) => ({ label: label(element).slice(0, 160), disabled: !!element.disabled }))
    });
    const bindCurrentExam = ({ examBinding, expectedExamCode, allowSubmit }) => {
      if (typeof examBinding !== "string" || !examBinding) throw new Error("Missing exam binding");
      if (location2.pathname !== "/student/virtual_school/exam.php") throw new Error("Open an exam question first");
      const question = readQuestion();
      if (question.examCode !== expectedExamCode) throw new Error("Stale exam code; read the current question again");
      currentExamBinding = { id: examBinding, url: location2.href, code: null, submissionAllowed: allowSubmit === true };
      return { mode: "exam", origin: currentOrigin(), examBinding, submissionAllowed: currentExamBinding.submissionAllowed };
    };
    const supports = (locationLike = location2) => INT_HOST.test(locationLike.hostname);
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
      if (message.scope?.mode === "exam" && !["read_question", "apply_answer", "navigate_next", "inspect_page"].includes(action) && !(action === "submit_exam" && currentExamBinding?.submissionAllowed === true && message.scope.submissionAllowed === true)) {
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

  // src/web-adapters/virtual-school.mjs
  var COURSE_PATH = /^\/Course\/?$/iu;
  var STUDY_COURSE_PATH = /^\/StudyCourse\/?$/iu;
  var EXAM_PATH = /^\/Exam\/?$/iu;
  var CONTENT_PATH = /^\/Content\/?$/iu;
  var REVIEW_PATH = /^\/(examanswers|AllExamAnswers)\/?$/iu;
  var createVirtualSchoolAdapter = ({ document: document2, location: location2 }) => {
    let currentExamBinding = null;
    let virtualAttemptId = null;
    const observedAnswers = /* @__PURE__ */ new Map();
    let reviewSnapshot = "";
    let reviewSequence = 0;
    const reviewEpoch = Math.random().toString(36).slice(2);
    const currentUrl = () => pageUrl(location2);
    const currentOrigin = () => currentUrl().origin;
    const controls = () => [...document2.querySelectorAll("button, a")].filter(visible);
    const virtualImageHidden = (image) => image?.hidden === true || image?.style?.display === "none";
    const virtualImageSource = (image) => image && !virtualImageHidden(image) ? image.currentSrc || image.src || null : null;
    const virtualQuestionImage = () => document2.querySelector('main img[src*="/question_pic/"]');
    const virtualExamTotal = () => {
      const total = Number(text(document2.body).match(/ทั้งหมด\s*(\d+)\s*ข้อ/u)?.[1]);
      if (!Number.isInteger(total) || total < 1 || total > 1e3) {
        throw new Error("Virtual School exam total is missing or invalid");
      }
      return total;
    };
    const virtualSchoolMetadata = () => {
      const number = Number((document2.querySelector("main h2")?.innerText || "").match(/ข้อคำถามที่\s*(\d+)/u)?.[1]);
      const code = examCode(document2.body);
      if (!number || !code) throw new Error("question metadata not found");
      return { number, code, token: `${code}:${number}` };
    };
    const readQuestion = () => {
      if (!EXAM_PATH.test(location2.pathname)) {
        throw new Error(`Current page is ${location2.pathname}, not an exam question; use inspect_page`);
      }
      if (/ส่งคำตอบเรียบร้อยแล้ว/u.test(document2.body?.innerText || "")) {
        throw new Error("Exam already submitted; use inspect_page or advance_subject to inspect the result");
      }
      const question = document2.querySelector(".exam-question");
      const imageElement = virtualQuestionImage();
      const image = virtualImageSource(imageElement);
      if (!question && !image) throw new Error("Exam question is not ready; inspect the page before retrying");
      const { number, token } = virtualSchoolMetadata();
      const choices = [...document2.querySelectorAll('main input[type="radio"]')].map((radio, position) => {
        const content = radio.nextElementSibling;
        const choiceImage = content?.querySelector("img");
        const choiceImageSource = virtualImageSource(choiceImage);
        const contentText = text(content);
        return {
          index: position + 1,
          text: contentText || (choiceImage ? "" : (radio.value || "").trim()),
          image: choiceImageSource,
          checked: radio.checked
        };
      });
      if (!choices.length) throw new Error("answer choices not found");
      const checked = choices.find((choice) => choice.checked);
      if (checked) observedAnswers.set(token, checked.index);
      else observedAnswers.delete(token);
      return {
        ok: true,
        questionNumber: number,
        totalQuestions: virtualExamTotal(),
        examCode: token,
        questionText: text(question),
        questionImage: image,
        choices,
        done: false
      };
    };
    const applyAnswer = ({ choiceIndex, expectedExamCode, save }) => {
      const { examCode: token } = readQuestion();
      if (token !== String(expectedExamCode)) throw new Error(`stale exam code: ${token}`);
      const radio = [...document2.querySelectorAll('main input[type="radio"]')][Number(choiceIndex) - 1];
      if (!radio) throw new Error("answer choice not found");
      radio.click();
      if (!radio.checked) throw new Error("answer choice was not selected");
      observedAnswers.set(token, Number(choiceIndex));
      return {
        ok: true,
        examCode: token,
        selected: Number(choiceIndex),
        saved: null,
        selectionVerified: true,
        saveRequested: save === true,
        persistence: "unverified_until_submission"
      };
    };
    const navigateNext = ({ expectedExamCode }) => {
      const { token } = virtualSchoolMetadata();
      if (token !== String(expectedExamCode)) throw new Error(`stale exam code: ${token}`);
      const button = [...document2.querySelectorAll("main button")].find((element) => text(element) === "\u0E02\u0E49\u0E2D\u0E16\u0E31\u0E14\u0E44\u0E1B");
      if (!button || button.disabled) return { ok: true, done: true };
      button.click();
      return { ok: true, done: false };
    };
    const courseIdentity = () => {
      const params = currentUrl().searchParams;
      return {
        subjectCode: aliasQueryValue(params, ["subject", "subjectCode", "subj", "code"], "subject"),
        level: singleQueryValue(params, "level"),
        selectedLevel: singleQueryValue(params, "selectedLevel"),
        term: singleQueryValue(params, "term"),
        year: singleQueryValue(params, "year"),
        subjectName: aliasQueryValue(params, ["subjectName", "title", "SUBJECT_NAME"], "subjectName") || text(document2.querySelector("h1")) || null
      };
    };
    const chapterCards = () => [...document2.querySelectorAll("article")].map((card) => {
      const header = card.querySelector("button");
      const number = Number(text(header).match(/^บทที่\s*(\d+)(?:\s|$)/u)?.[1]);
      return { card, header, number, title: text(header?.querySelector("h4")) };
    }).filter(({ number }) => number > 0);
    const isPretest = () => singleQueryValue(currentUrl().searchParams, "examtype") === "P" && /แบบทดสอบก่อนเรียน/u.test(text(document2.body));
    const assertScope = (scope) => {
      if (scope?.mode === "exam") {
        if (!currentExamBinding || scope.examBinding !== currentExamBinding.id || location2.href !== currentExamBinding.url) {
          throw new Error("Current-exam scope expired; inspect and bind the open exam again");
        }
        if (virtualSchoolMetadata().code !== currentExamBinding.code) throw new Error("Current exam changed; inspect and bind again");
        return;
      }
      if (!scope || !["chapter", "subject", "final"].includes(scope.mode)) {
        throw new Error("Set an explicit scope before taking actions");
      }
      if (scope.origin !== currentOrigin()) throw new Error("Scoped automation is only verified for main.virtualschool.club");
      const current = courseIdentity();
      for (const key of ["subjectCode", "level", "term", "year"]) {
        if (!scope[key] || current[key] !== scope[key]) throw new Error(`Scope mismatch or missing ${key}`);
      }
      if (!/^\/(StudyCourse|Content|Exam|examanswers|AllExamAnswers)\/?$/iu.test(location2.pathname)) {
        throw new Error("Page is outside the supported scoped routes");
      }
      if (scope.mode === "final" && !STUDY_COURSE_PATH.test(location2.pathname) && (!/^\/(Exam|examanswers|AllExamAnswers)\/?$/iu.test(location2.pathname) || singleQueryValue(currentUrl().searchParams, "examtype") !== "F")) {
        throw new Error("Page is outside the requested final exam");
      }
      if (scope.virtualActivity?.examType === "F" && !STUDY_COURSE_PATH.test(location2.pathname) && singleQueryValue(currentUrl().searchParams, "examtype") !== "F") {
        throw new Error("Page is outside the active Virtual final attempt");
      }
      if (scope.mode === "chapter" && singleQueryValue(currentUrl().searchParams, "examtype") === "F") {
        throw new Error("Final exam is outside the requested chapter");
      }
      if (scope.mode !== "chapter") return;
      if (!Number.isInteger(scope.chapter) || scope.chapter < 1 || !scope.chapterTitle) {
        throw new Error("Invalid chapter scope");
      }
      if (STUDY_COURSE_PATH.test(location2.pathname)) {
        const cards = chapterCards();
        if (!cards.length) throw new Error("Chapter overview is loading");
        const matches = cards.filter((entry) => entry.number === scope.chapter);
        if (matches.length !== 1 || matches[0].title !== scope.chapterTitle || cards.filter((entry) => entry.title === scope.chapterTitle).length !== 1) {
          throw new Error("Target chapter cannot be identified");
        }
        return;
      }
      const params = currentUrl().searchParams;
      if (CONTENT_PATH.test(location2.pathname)) {
        if (params.get("lessonTitle") !== scope.chapterTitle) throw new Error("Lesson is outside the requested chapter");
      } else if (Number(params.get("chapter")) !== scope.chapter || params.get("SUB_SUBJECT_NAME") !== scope.chapterTitle) {
        throw new Error("Exam is outside the requested chapter");
      }
    };
    const assertSubmission = ({ expectedExamCode, scope }) => {
      const { token, code, number } = virtualSchoolMetadata();
      if (token !== expectedExamCode) throw new Error(`stale exam code: ${token}`);
      const emptyPretestAllowed = scope.mode !== "exam" && scope.allowEmptyPretest === true && isPretest();
      if (emptyPretestAllowed) return;
      const total = virtualExamTotal();
      const radios = [...document2.querySelectorAll('main input[type="radio"]')];
      const checked = radios.findIndex((radio) => radio.checked);
      if (checked >= 0) observedAnswers.set(`${code}:${number}`, checked + 1);
      else observedAnswers.delete(`${code}:${number}`);
      if (!total || total > 1e3 || /คุณยังทำข้อสอบไม่ครบ|ยังไม่ได้ทำอีก\s*[1-9]/u.test(text(document2.body)) || Array.from({ length: total }, (_, index) => `${code}:${index + 1}`).some((key) => !observedAnswers.has(key))) {
        throw new Error("Not every answer has been verified in this exam; refusing submission");
      }
    };
    const virtualSubmissionStatus = ({ scope } = {}) => {
      if (scope) assertScope(scope);
      if (!EXAM_PATH.test(location2.pathname)) {
        return { ok: true, submitted: false, path: location2.pathname, examType: singleQueryValue(currentUrl().searchParams, "examtype") };
      }
      const marker = /ส่งคำตอบเรียบร้อยแล้ว/u.test(text(document2.body));
      return {
        ok: true,
        submitted: marker,
        marker: marker ? "\u0E2A\u0E48\u0E07\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E40\u0E23\u0E35\u0E22\u0E1A\u0E23\u0E49\u0E2D\u0E22\u0E41\u0E25\u0E49\u0E27" : null,
        path: location2.pathname,
        examType: singleQueryValue(currentUrl().searchParams, "examtype")
      };
    };
    const beginVirtualAttempt = ({ attemptId, scope } = {}) => {
      if (scope) assertScope(scope);
      if (!["subject", "final"].includes(scope?.mode)) throw new Error("Virtual attempt entry requires a scoped subject or final");
      if (typeof attemptId !== "string" || !attemptId) throw new Error("Missing Virtual attempt ID");
      observedAnswers.clear();
      virtualAttemptId = attemptId;
      return { ok: true, attemptId, observedAnswersReset: true };
    };
    const advanceSubject = (scope, nextVirtualAttemptId, nextVirtualAttemptEnteredAt) => {
      const currentControls = controls();
      if (EXAM_PATH.test(location2.pathname) && /ส่งคำตอบเรียบร้อยแล้ว/u.test(text(document2.body))) {
        if (singleQueryValue(currentUrl().searchParams, "examtype") === "F") {
          const marker = "\u0E2A\u0E48\u0E07\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E40\u0E23\u0E35\u0E22\u0E1A\u0E23\u0E49\u0E2D\u0E22\u0E41\u0E25\u0E49\u0E27";
          if (scope.retryUntilPerfect && !scope.virtualActivity?.reviewBound) {
            return {
              ok: true,
              mode: "review_required",
              submitted: true,
              terminalStatus: true,
              submittedMarker: marker,
              finalResult: scope.virtualActivity?.finalResult || null,
              reviewBound: false
            };
          }
          return {
            ok: true,
            mode: "complete",
            submitted: true,
            terminalStatus: true,
            submittedMarker: marker,
            finalResult: scope.virtualActivity?.finalResult || null
          };
        }
        const next = currentControls.find((element) => /^(เริ่มเรียนเนื้อหา|ดูเฉลยคำตอบ)$/u.test(text(element)));
        if (next) next.click();
        return { ok: true, mode: "result", action: next ? "returned" : "waiting" };
      }
      if (REVIEW_PATH.test(location2.pathname)) {
        const back = currentControls.find((element) => /^(?:←\s*)?กลับไปหน้าเรียน$/u.test(text(element)));
        if (back) back.click();
        return { ok: true, mode: "result", action: back ? "returned" : "waiting" };
      }
      const dialog = document2.querySelector('.swal2-container, [role="dialog"][aria-modal="true"]');
      if (CONTENT_PATH.test(location2.pathname)) {
        if (/กำลังโหลดบทเรียน/u.test(text(document2.body))) return { ok: true, mode: "lesson", action: "waiting" };
        if (dialog && visible(dialog)) {
          const confirmLesson = [...dialog.querySelectorAll("button, a")].find((element) => visible(element) && text(element) === "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E2D\u0E2D\u0E01\u0E1A\u0E17\u0E40\u0E23\u0E35\u0E22\u0E19");
          if (confirmLesson && text(dialog).includes("\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E01\u0E32\u0E23\u0E2D\u0E2D\u0E01\u0E1A\u0E17\u0E40\u0E23\u0E35\u0E22\u0E19")) {
            confirmLesson.click();
            return { ok: true, mode: "lesson", action: "confirmed" };
          }
          return { ok: true, mode: "lesson", action: "waiting" };
        }
        const exitLesson = currentControls.find((element) => text(element) === "\u0E2D\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E1A\u0E17\u0E40\u0E23\u0E35\u0E22\u0E19");
        if (exitLesson) {
          exitLesson.click();
          return { ok: true, mode: "lesson", action: "exit_opened" };
        }
        return { ok: true, mode: "lesson", action: "waiting" };
      }
      if (dialog && visible(dialog)) return { ok: true, mode: "submission", action: "confirmation_required" };
      if (EXAM_PATH.test(location2.pathname)) {
        if ((document2.querySelector(".exam-question") || virtualQuestionImage()) && document2.querySelectorAll('main input[type="radio"]').length) {
          const pretest = isPretest();
          return { ok: true, mode: "exam", pretest, needsAnswers: !(pretest && scope.allowEmptyPretest === true) };
        }
        return { ok: true, mode: "exam", action: "waiting", ready: false };
      }
      if (STUDY_COURSE_PATH.test(location2.pathname)) {
        if (scope.mode === "subject" && /ความคืบหน้า\s*100%/u.test(text(document2.body))) return { ok: true, mode: "complete" };
        const cards = chapterCards().filter((entry) => scope.mode !== "final" && (scope.mode === "subject" || entry.number === scope.chapter));
        for (const { card, header, number } of cards) {
          const local = [...card.querySelectorAll("button, a")].filter(visible);
          const pretest = local.find((element) => text(element) === "\u0E01\u0E48\u0E2D\u0E19\u0E40\u0E23\u0E35\u0E22\u0E19");
          const posttest = local.find((element) => text(element) === "\u0E2B\u0E25\u0E31\u0E07\u0E40\u0E23\u0E35\u0E22\u0E19");
          const topics = [...card.querySelectorAll('button[aria-label^="\u0E40\u0E1B\u0E34\u0E14\u0E1A\u0E17\u0E40\u0E23\u0E35\u0E22\u0E19:"]')];
          const finished = (element) => element?.classList.contains("bg-emerald-500");
          const complete = /ผ่านเกณฑ์หน่วยเรียนแล้ว/u.test(text(card)) && finished(pretest) && finished(posttest) && topics.length > 0 && topics.every((element) => element.querySelector("svg.text-emerald-500"));
          if (complete) {
            if (scope.mode === "chapter") return { ok: true, mode: "chapter_complete", chapter: number };
            continue;
          }
          if (!card.querySelector('button[aria-label^="\u0E40\u0E1B\u0E34\u0E14\u0E1A\u0E17\u0E40\u0E23\u0E35\u0E22\u0E19:"]')) {
            if (!visible(header)) return { ok: true, mode: "overview", action: "waiting" };
            header.click();
            return { ok: true, mode: "overview", action: "expanded", chapter: number };
          }
          const lesson = topics.find((element) => visible(element) && !element.querySelector("svg.text-emerald-500") && !/(?:กรุณาศึกษา|ล็อก)/u.test(label(element)));
          const activity = pretest && !finished(pretest) ? pretest : lesson || (posttest && !finished(posttest) ? posttest : null);
          if (activity) {
            activity.click();
            return { ok: true, mode: "overview", action: "opened", chapter: number, activity: label(activity) };
          }
          return { ok: true, mode: "overview", action: "waiting", chapter: number };
        }
        if (scope.virtualActivity?.submitted) {
          if (!scope.retryUntilPerfect) return {
            ok: true,
            mode: "complete",
            submitted: true,
            terminalStatus: true,
            finalResult: scope.virtualActivity.finalResult || null
          };
          const score = scope.virtualActivity.finalResult;
          if (score && score.correct === score.total && score.total > 0) {
            return { ok: true, mode: "complete", submitted: true, terminalStatus: true, finalResult: score };
          }
          if (!scope.virtualActivity.reviewBound) {
            return {
              ok: true,
              mode: "review_required",
              submitted: true,
              terminalStatus: true,
              finalResult: score || null,
              reviewBound: false
            };
          }
        }
        const finalExam = ["subject", "final"].includes(scope.mode) && currentControls.find((element) => text(element) === "\u0E17\u0E33\u0E41\u0E1A\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E1B\u0E25\u0E32\u0E22\u0E20\u0E32\u0E04");
        if (finalExam) {
          observedAnswers.clear();
          virtualAttemptId = typeof nextVirtualAttemptId === "string" && nextVirtualAttemptId ? nextVirtualAttemptId : null;
          const enteredAt = Number.isFinite(nextVirtualAttemptEnteredAt) ? nextVirtualAttemptEnteredAt : Date.now();
          finalExam.click();
          return {
            ok: true,
            mode: "overview",
            action: "opened",
            activity: label(finalExam),
            virtualFinalOpened: true,
            observedAnswersReset: true,
            virtualAttemptId,
            virtualAttemptEnteredAt: enteredAt
          };
        }
        return scope.mode === "final" ? { ok: true, mode: "scope_boundary", reason: "Final exam is not available" } : { ok: true, mode: "overview", action: "waiting" };
      }
      return { ok: true, mode: "lesson", action: "waiting" };
    };
    const choiceLabelIndex = (value) => ["1A\u0E01", "2B\u0E02", "3C\u0E04", "4D\u0E07", "5E\u0E08"].findIndex((labels) => value && labels.includes(value)) + 1;
    const readVirtualReviewScore = () => {
      const labels = [...document2.querySelectorAll("p, span")].filter((element) => text(element) === "\u0E04\u0E30\u0E41\u0E19\u0E19\u0E23\u0E27\u0E21");
      const scores = labels.map((element) => text(element.nextElementSibling).match(/^(\d+)\s*\/\s*(\d+)$/u)).filter(Boolean).map((match) => ({ correct: Number(match[1]), total: Number(match[2]), passed: null }));
      if (!scores.length) return null;
      if (new Set(scores.map((score2) => `${score2.correct}/${score2.total}`)).size !== 1) {
        throw new Error("Virtual School review score is ambiguous");
      }
      const score = scores[0];
      if (!Number.isInteger(score.total) || score.total < 1 || score.total > 1e3 || score.correct < 0 || score.correct > score.total) return null;
      return score;
    };
    const readVirtualSubmittedScore = () => {
      const body = text(document2.body);
      const marker = body.indexOf("\u0E2A\u0E48\u0E07\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E40\u0E23\u0E35\u0E22\u0E1A\u0E23\u0E49\u0E2D\u0E22\u0E41\u0E25\u0E49\u0E27");
      if (marker < 0) return null;
      const resultText = body.slice(marker);
      if (!resultText.includes("\u0E44\u0E14\u0E49\u0E04\u0E30\u0E41\u0E19\u0E19")) return readVirtualReviewScore();
      const matches = [...resultText.matchAll(/ได้คะแนน\s*(\d+)\s*คะแนนเต็ม\s*(\d+)/gu)];
      if (!matches.length) return null;
      if (new Set(matches.map((match) => `${match[1]}/${match[2]}`)).size !== 1) {
        throw new Error("Virtual School submitted score is ambiguous");
      }
      const correct = Number(matches[0][1]);
      const total = Number(matches[0][2]);
      if (!Number.isInteger(total) || total < 1 || total > 1e3 || correct < 0 || correct > total) return null;
      const passed = /ไม่ผ่านเกณฑ์|ยังไม่ผ่าน/u.test(resultText) ? false : /ผ่านเกณฑ์/u.test(resultText) ? true : null;
      return { correct, total, passed };
    };
    const virtualReviewImage = (root, selector) => {
      const images = [...root?.querySelectorAll(selector) || []];
      const available = images.filter((image2) => !virtualImageHidden(image2));
      if (available.length > 1) throw new Error("Multiple review images cannot be represented without losing content");
      const image = available[0];
      const source = virtualImageSource(image);
      const failed = source && image.complete === true && image.naturalWidth === 0 ? 1 : 0;
      return { image: source, unavailable: images.filter((candidate) => virtualImageHidden(candidate) || !virtualImageSource(candidate)).length, failed };
    };
    const readVirtualReviewQuestion = (root, questionNumber, totalQuestions, all = false) => {
      const question = root?.querySelector(".prose");
      const questionImage = virtualReviewImage(root, 'img[src*="/question_pic/"]');
      const cards = [...root?.querySelectorAll("div.group") || []];
      let unavailableImageCount = questionImage.unavailable;
      let failedImageCount = questionImage.failed;
      const correct = [];
      const selected = [];
      const correctLabels = [];
      const choices = cards.map((card, position) => {
        const glyph = text(all ? card.firstElementChild : card.firstElementChild?.firstElementChild);
        const index = choiceLabelIndex(glyph);
        if (index !== position + 1) throw new Error("Virtual School review choice labels are missing or ambiguous");
        const badges = [...card.querySelectorAll("span")].map(text);
        const marker = badges.filter((caption) => caption === (all ? "\u0E40\u0E09\u0E25\u0E22\u0E17\u0E35\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07" : "\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E17\u0E35\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07") || all && caption === "\u0E15\u0E2D\u0E1A\u0E02\u0E49\u0E2D\u0E19\u0E35\u0E49 \u0E41\u0E25\u0E30\u0E15\u0E2D\u0E1A\u0E16\u0E39\u0E01");
        if (marker.length > 1) throw new Error("Virtual School correct-answer label is ambiguous");
        if (marker.length === 1) {
          correct.push(index);
          correctLabels.push(marker[0]);
        }
        const selection = all ? badges.filter((caption) => caption === "\u0E40\u0E1B\u0E47\u0E19\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E17\u0E35\u0E48\u0E40\u0E25\u0E37\u0E2D\u0E01" || caption === "\u0E15\u0E2D\u0E1A\u0E02\u0E49\u0E2D\u0E19\u0E35\u0E49 \u0E41\u0E25\u0E30\u0E15\u0E2D\u0E1A\u0E16\u0E39\u0E01") : [];
        if (selection.length > 1) throw new Error("Virtual School selected-answer label is ambiguous");
        if (selection.length === 1) selected.push(index);
        const image = virtualReviewImage(card, 'img[src*="/answers_pic/"]');
        unavailableImageCount += image.unavailable;
        failedImageCount += image.failed;
        const choice = { index, text: text(card.querySelector(".break-words")), image: image.image, checked: null };
        if (!choice.text && !choice.image) throw new Error("Virtual School review choice content is not ready");
        return choice;
      });
      if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > totalQuestions || !text(question) && !questionImage.image || !choices.length || correct.length !== 1) {
        throw new Error("Review question or explicit correct answer is not ready");
      }
      const unanswered = /คุณไม่ได้เลือกคำตอบในข้อนี้|ผิด\s*\(ไม่ได้เลือกคำตอบ\)/u.test(text(root));
      if (selected.length > 1 || unanswered && selected.length) throw new Error("Virtual School selected-answer evidence is contradictory");
      const selectedChoiceIndex = selected[0] || null;
      if (selectedChoiceIndex !== null) choices.forEach((choice) => {
        choice.checked = choice.index === selectedChoiceIndex;
      });
      return {
        questionNumber,
        totalQuestions,
        examCode: null,
        questionText: text(question),
        questionImage: questionImage.image,
        choices,
        correctChoiceIndex: correct[0],
        selectedChoiceIndex,
        selectionState: unanswered ? "unanswered" : selectedChoiceIndex !== null ? "selected" : "unknown",
        correctness: unanswered ? "incorrect" : selectedChoiceIndex !== null ? selectedChoiceIndex === correct[0] ? "correct" : "incorrect" : "unverified",
        verificationSource: "Virtual School explicit correct-answer label",
        evidence: `${correctLabels[0]}: ${["\u0E01", "\u0E02", "\u0E04", "\u0E07", "\u0E08"][correct[0] - 1]}`,
        unavailableImageCount,
        failedImageCount,
        url: location2.href
      };
    };
    const readVirtualReview = () => {
      const all = /^\/AllExamAnswers\/?$/iu.test(location2.pathname);
      const score = readVirtualReviewScore();
      const base = {
        score,
        ready: false,
        reviewComplete: false,
        reviewLayout: all ? "all" : "single",
        totalQuestions: score?.total || null,
        reviewedQuestionNumbers: [],
        verifiedReviews: []
      };
      if (!score) return base;
      if (all) {
        const cards = [...document2.querySelectorAll('section[id^="question-"]')];
        const numbers = cards.map((card) => Number((card.id || "").match(/^question-(\d+)$/u)?.[1]));
        if (new Set(numbers).size !== numbers.length) throw new Error("Virtual School review question numbers are ambiguous");
        const reviews = cards.map((card, index) => readVirtualReviewQuestion(card, numbers[index], score.total, true));
        const complete = reviews.length === score.total && Array.from({ length: score.total }, (_, index) => index + 1).every((number2) => numbers.includes(number2));
        return { ...base, verifiedReviews: reviews, reviewedQuestionNumbers: numbers, ready: complete, reviewComplete: complete };
      }
      const root = document2.querySelector("#main-question-area");
      const number = Number(text(root).match(/โจทย์ข้อที่\s*(\d+)/u)?.[1]);
      if (!root || !number) return base;
      const question = readVirtualReviewQuestion(root, number, score.total);
      return { ...base, ...question, ready: true, reviewedQuestionNumbers: [number] };
    };
    const readExamResult = () => {
      const body = text(document2.body);
      const resultPage = REVIEW_PATH.test(location2.pathname) || EXAM_PATH.test(location2.pathname) && /ส่งคำตอบเรียบร้อยแล้ว/u.test(body);
      if (!resultPage) throw new Error("Open the submitted result or answer-review page first");
      const review = controls().filter((element) => /^(ดูเฉลยคำตอบ|ดูเฉลย|ต้องการดูวิดีโอเฉลย)$/u.test(text(element)));
      const question = REVIEW_PATH.test(location2.pathname) ? readVirtualReview() : null;
      const virtualScore = !question && EXAM_PATH.test(location2.pathname) ? readVirtualSubmittedScore() : null;
      const snapshot = REVIEW_PATH.test(location2.pathname) ? JSON.stringify({
        url: location2.href,
        body,
        review: question,
        imageSources: [...document2.querySelectorAll('img[src*="/question_pic/"], img[src*="/answers_pic/"]') || []].filter((image) => !virtualImageHidden(image)).map((image) => [image.currentSrc || image.src || null, image.hidden === true, image.style?.display || ""])
      }) : `${location2.href}#${body.replace(/เวลาสอบ\s+\d{2}:[0-5]\d:[0-5]\d(?=\s|$)/gu, "\u0E40\u0E27\u0E25\u0E32\u0E2A\u0E2D\u0E1A <clock>")}`;
      if (snapshot !== reviewSnapshot) {
        reviewSnapshot = snapshot;
        reviewSequence += 1;
      }
      return {
        ok: true,
        url: location2.href,
        resultToken: `${reviewEpoch}:${reviewSequence}`,
        resultText: question ? question.evidence || "Virtual School submitted answer review" : body,
        score: virtualScore || question?.score || null,
        reviewAvailable: review.length === 1,
        correctness: "unverified",
        questionImage: null,
        choices: [],
        submittedMarker: EXAM_PATH.test(location2.pathname) && /ส่งคำตอบเรียบร้อยแล้ว/u.test(body) ? "\u0E2A\u0E48\u0E07\u0E04\u0E33\u0E15\u0E2D\u0E1A\u0E40\u0E23\u0E35\u0E22\u0E1A\u0E23\u0E49\u0E2D\u0E22\u0E41\u0E25\u0E49\u0E27" : null,
        ...question
      };
    };
    const openAnswerReview = ({ expectedResultToken, step = "open", questionNumber }) => {
      const result = readExamResult();
      if (result.resultToken !== expectedResultToken) throw new Error("Result changed; read it again");
      let target;
      if (REVIEW_PATH.test(location2.pathname)) {
        const unique = (predicate) => {
          const matches = controls().filter(predicate);
          if (matches.length !== 1) throw new Error("Review navigation control unavailable or ambiguous");
          return matches[0];
        };
        if (step === "return") target = unique((element) => /^(?:←\s*)?กลับไปหน้าเรียน$/u.test(text(element)));
        else if (!result.ready) throw new Error("Virtual School review is not ready");
        else if (step === "sheet") {
          if (result.reviewLayout === "all") return { ok: true, action: "all_review_already_open", done: false };
          target = unique((element) => text(element) === "\u0E14\u0E39\u0E40\u0E09\u0E25\u0E22\u0E17\u0E38\u0E01\u0E02\u0E49\u0E2D\u0E43\u0E19\u0E0A\u0E38\u0E14\u0E19\u0E35\u0E49");
        } else if (step === "next" && result.reviewLayout === "single") {
          if (result.questionNumber === result.totalQuestions) return { ok: true, done: true };
          target = unique((element) => text(element) === "\u0E02\u0E49\u0E2D\u0E16\u0E31\u0E14\u0E44\u0E1B");
        } else if (step === "question" && result.reviewLayout === "single") {
          if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > result.totalQuestions) throw new Error("Invalid review question number");
          if (questionNumber === result.questionNumber) return { ok: true, action: "question_already_open", done: false };
          const numbered = controls().filter((element) => text(element) === String(questionNumber));
          target = numbered.length === 1 ? numbered[0] : unique((element) => text(element) === `\u0E02\u0E49\u0E2D ${questionNumber}`);
        } else throw new Error("This review step is unavailable on the current Virtual School view");
        target.click();
        return { ok: true, action: step === "sheet" ? "opened_all_review" : step === "return" ? "returned" : "next", done: false };
      }
      if (step !== "open" || !result.reviewAvailable) throw new Error("A unique answer-review control is not available");
      target = controls().find((element) => /^(ดูเฉลยคำตอบ|ดูเฉลย|ต้องการดูวิดีโอเฉลย)$/u.test(text(element)));
      if (!visible(target)) throw new Error("Review navigation control unavailable");
      target.click();
      return { ok: true, action: "opened_review", done: false };
    };
    const normalizeCaption = (value) => String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const listContext = () => {
      const url = currentUrl();
      const params = url.searchParams;
      return {
        origin: url.origin,
        path: url.pathname,
        level: singleQueryValue(params, "level"),
        term: singleQueryValue(params, "term"),
        year: singleQueryValue(params, "year")
      };
    };
    const listIdentity = (context, captions) => JSON.stringify({ ...context, captions });
    const opaqueToken = (prefix, value) => `${prefix}:${encodeURIComponent(value)}`;
    const subjectCards = () => [...document2.querySelectorAll(".card-body")].filter(visible);
    const readSubjectCard = (card) => {
      const title = normalizeCaption(text(card.querySelector("h3.card-title")));
      if (!title) throw new Error("Virtual School subject card title is missing");
      const progressText = text(card.querySelector(".prog-pct"));
      const progressMatch = progressText.match(/^(\d+(?:\.\d+)?)%$/u);
      if (!progressMatch) throw new Error(`Virtual School progress is unknown for subject ${title}`);
      const progress = Number(progressMatch[1]);
      if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error(`Virtual School progress is invalid for subject ${title}`);
      const action = [...card.querySelectorAll("button.btn-primary")].filter(visible);
      if (action.length !== 1) throw new Error(`Virtual School subject action is unavailable or ambiguous for subject ${title}`);
      const button = action[0];
      return {
        title,
        caption: title,
        semester: text(card.querySelector(".meta-chip")) || null,
        progress,
        progressText,
        finished: progress === 100,
        finalStatus: text(card.querySelector(".final-status")) || null,
        finalFailed: !!card.querySelector(".final-status > .final--fail"),
        action: text(button),
        disabled: !!button.disabled || button.getAttribute?.("aria-disabled") === "true" || button.classList?.contains("disabled")
      };
    };
    const readSubjects = () => {
      if (!COURSE_PATH.test(location2.pathname)) throw new Error("Open the Virtual School subject selection page first");
      const context = listContext();
      const cards = subjectCards();
      if (!cards.length) throw new Error("Virtual School subject list is empty or still loading");
      const parsedCards = cards.map((card) => readSubjectCard(card));
      if (new Set(parsedCards.map((card) => card.caption)).size !== parsedCards.length) {
        throw new Error("Virtual School subject captions are ambiguous");
      }
      const identity = listIdentity(context, parsedCards.map((card) => card.caption));
      const resultCards = parsedCards.map((card) => ({
        ...card,
        cardToken: opaqueToken("virtual-card", JSON.stringify([context, card.caption]))
      }));
      return {
        origin: currentOrigin(),
        path: location2.pathname,
        listContext: context,
        level: context.level,
        term: context.term,
        year: context.year,
        listToken: opaqueToken("virtual-list", identity),
        cards: resultCards
      };
    };
    const openSubject = ({ listToken, cardToken }) => {
      if (typeof listToken !== "string" || !listToken) throw new Error("Missing Virtual School listToken");
      if (typeof cardToken !== "string" || !cardToken) throw new Error("Missing Virtual School cardToken");
      const list = readSubjects();
      if (list.listToken !== listToken) throw new Error("Subject list changed; read_subjects again");
      const subject = list.cards.find((candidate) => candidate.cardToken === cardToken);
      if (!subject) throw new Error("Subject card is missing or stale; read_subjects again");
      if (subject.finished) throw new Error("Subject is already finished");
      if (subject.disabled || !/^(?:เริ่มเรียน|ดำเนินการต่อ)$/u.test(subject.action)) throw new Error("Subject action is disabled or unavailable");
      const cards = subjectCards();
      const index = list.cards.findIndex((candidate) => candidate.cardToken === cardToken);
      const card = cards[index];
      const action = [...card?.querySelectorAll("button.btn-primary") || []].filter(visible);
      if (action.length !== 1 || action[0].disabled || action[0].getAttribute?.("aria-disabled") === "true" || !/^(?:เริ่มเรียน|ดำเนินการต่อ)$/u.test(text(action[0]))) {
        throw new Error("Subject action is unavailable or stale; read_subjects again");
      }
      action[0].click();
      const opened = STUDY_COURSE_PATH.test(location2.pathname) ? inspectPage() : null;
      return {
        ok: true,
        action: "opened_subject",
        cardToken,
        subjectCode: opened?.course?.subjectCode || null,
        course: opened?.course || null,
        destinationPath: location2.pathname,
        destinationConfirmed: !!opened,
        next: opened ? "Set normal subject scope from the returned course identity" : "Inspect the loaded StudyCourse, then set normal subject scope"
      };
    };
    const returnToSubjects = ({ scope }) => {
      assertScope(scope);
      if (!STUDY_COURSE_PATH.test(location2.pathname) || scope.mode !== "subject") {
        throw new Error("Return to the scoped Virtual School course overview first");
      }
      const back = [...document2.querySelectorAll('button[title="\u0E22\u0E49\u0E2D\u0E19\u0E01\u0E25\u0E31\u0E1A"]')].filter(visible);
      if (back.length !== 1) throw new Error("Virtual School subject-list return control is unavailable or ambiguous");
      back[0].click();
      const confirmed = COURSE_PATH.test(location2.pathname);
      const list = confirmed ? readSubjects() : null;
      return {
        ok: true,
        action: "returned_to_subjects",
        destinationPath: location2.pathname,
        destinationConfirmed: confirmed,
        listToken: list?.listToken || null,
        next: confirmed ? "Read the subject list and compare its listToken before continuing" : "Wait for /Course, then read the subject list before continuing"
      };
    };
    const submitCurrentExam = (message) => {
      if (!EXAM_PATH.test(location2.pathname)) throw new Error("current page is not a supported exam");
      if (/ส่งคำตอบเรียบร้อยแล้ว/u.test(text(document2.body))) {
        return { ...virtualSubmissionStatus(), mode: "result", action: "already_submitted" };
      }
      assertSubmission(message);
      const dialog = document2.querySelector('.swal2-container, [role="dialog"][aria-modal="true"]');
      if (dialog && visible(dialog)) {
        if (/กระดาษคำตอบ/u.test(text(dialog)) && !/ยืนยันการส่งคำตอบ|คุณยังทำข้อสอบไม่ครบ/u.test(text(dialog))) {
          const submit2 = [...dialog.querySelectorAll("button")].find((element) => visible(element) && text(element) === "\u0E2A\u0E48\u0E07\u0E04\u0E33\u0E15\u0E2D\u0E1A");
          if (!submit2) return { ok: true, mode: "submission", action: "waiting" };
          submit2.click();
          return { ok: true, mode: "submission", action: "opened" };
        }
        if (!/ยืนยันการส่งคำตอบ|คุณยังทำข้อสอบไม่ครบ/u.test(text(dialog))) throw new Error("Unknown submission dialog; inspect the page");
        const confirm = [...dialog.querySelectorAll("button")].find((element) => visible(element) && text(element) === "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19\u0E01\u0E32\u0E23\u0E2A\u0E48\u0E07");
        if (!confirm) return { ok: true, mode: "submission", action: "waiting" };
        confirm.click();
        return { ok: true, mode: "submission", action: "confirmed" };
      }
      const submit = controls().find((element) => /^(?:ส่งคำตอบ(?:ทั้งหมด)?|ส่งข้อสอบ|ส่งแบบทดสอบ|ยืนยันส่งคำตอบ|ยืนยันส่งข้อสอบ)$/u.test(text(element)));
      if (submit) {
        submit.click();
        return { ok: true, mode: "submission", action: "opened" };
      }
      const sheet = controls().find((element) => /ดูกระดาษคำตอบ/u.test(text(element)) && /ส่งคำตอบ/u.test(text(element)));
      if (!sheet) throw new Error("submit-all control unavailable");
      sheet.click();
      return { ok: true, mode: "submission", action: "opened_sheet" };
    };
    const inspectPage = () => ({
      path: location2.pathname,
      url: location2.href,
      origin: currentOrigin(),
      course: courseIdentity(),
      chapters: chapterCards().map(({ number, title }) => ({ number, title })),
      contentVersion: CONTENT_VERSION,
      controls: [...document2.querySelectorAll("button, a")].filter((element) => !element.getClientRects || element.getClientRects().length > 0).slice(0, 40).map((element) => ({ label: label(element).slice(0, 160), disabled: !!element.disabled }))
    });
    const bindCurrentExam = ({ examBinding, expectedExamCode, allowSubmit }) => {
      if (typeof examBinding !== "string" || !examBinding) throw new Error("Missing exam binding");
      if (!EXAM_PATH.test(location2.pathname)) throw new Error("Open an exam question first");
      const question = readQuestion();
      if (question.examCode !== expectedExamCode) throw new Error("Stale exam code; read the current question again");
      currentExamBinding = { id: examBinding, url: location2.href, code: virtualSchoolMetadata().code, submissionAllowed: allowSubmit === true };
      return { mode: "exam", origin: currentOrigin(), examBinding, submissionAllowed: currentExamBinding.submissionAllowed };
    };
    const supports = (locationLike = location2) => locationLike.hostname === "main.virtualschool.club";
    const handle = (action, message = {}) => {
      if (action === "page_version") return { contentVersion: CONTENT_VERSION };
      if (action === "read_subjects") return readSubjects();
      if (action === "open_subject") return openSubject(message);
      if (action === "return_to_subjects") return returnToSubjects(message);
      if (action === "bind_current_exam") return bindCurrentExam(message);
      if (action === "read_submission_status") return virtualSubmissionStatus(message);
      if (action === "begin_virtual_attempt") return beginVirtualAttempt(message);
      if (action === "read_exam_result") {
        if (message.scope) assertScope(message.scope);
        return readExamResult();
      }
      if (action === "open_answer_review") {
        if (message.scope) assertScope(message.scope);
        return openAnswerReview(message);
      }
      if (message.scope?.mode === "exam" && !["read_question", "apply_answer", "navigate_next", "inspect_page"].includes(action) && !(action === "submit_exam" && currentExamBinding?.submissionAllowed === true && message.scope.submissionAllowed === true)) {
        throw new Error("Current-exam scope allows answers only; submission and chapter navigation are disabled");
      }
      if (message.scope || ["apply_answer", "navigate_next", "advance_subject", "submit_exam"].includes(action)) assertScope(message.scope);
      if (action === "read_question") return readQuestion();
      if (action === "apply_answer") return applyAnswer(message);
      if (action === "navigate_next") return navigateNext(message);
      if (action === "advance_subject") return advanceSubject(message.scope, message.virtualAttemptId, message.virtualAttemptEnteredAt);
      if (action === "inspect_page") return inspectPage();
      if (action === "submit_exam") return submitCurrentExam(message);
      return null;
    };
    return { supports, inspect: inspectPage, handle };
  };

  // src/web-adapters/entrypoint.mjs
  (() => {
    if (globalThis.__intPracticeBridgeInstalled) return;
    globalThis.__intPracticeBridgeInstalled = true;
    const wakeBridge = () => chrome.runtime.sendMessage({ action: "keep_bridge_awake" }).catch(() => {
    });
    wakeBridge();
    setInterval(wakeBridge, 2e4);
    const adapters = [
      createIntProjectAdapter({ document, location }),
      createVirtualSchoolAdapter({ document, location })
    ];
    const currentAdapter = () => adapters.find((adapter) => adapter.supports(location));
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      try {
        if (message.action === "page_version") {
          sendResponse({ ok: true, result: { contentVersion: CONTENT_VERSION } });
          return true;
        }
        const adapter = currentAdapter();
        if (!adapter) throw new Error("Unsupported practice origin");
        const result = adapter.handle(message.action, message);
        if (result === null || result === void 0) return false;
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return true;
    });
  })();
})();
