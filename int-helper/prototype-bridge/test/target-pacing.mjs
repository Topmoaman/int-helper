import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const worker = readFileSync(process.argv[2] || new URL("extension/service-worker.js", root), "utf8");
const version = JSON.parse(readFileSync(new URL("extension/manifest.json", root), "utf8")).version;
const port = 17373;
const epoch = Date.parse("2026-09-11T00:00:00Z");

for (const origin of ["https://int-project.com", "https://main.virtualschool.club"]) {
  for (const minutes of [30, 60, 90, 119]) {
    for (const autoSubmit of [false, true]) {
      let handler, now = epoch, number = 1;
      const applied = [], submissions = [];
      const int = origin.includes("int-project");
      class Clock extends Date { static now() { return now; } }
      class Socket { static OPEN = 1; readyState = 1; send() {} }
      const page = { origin, path: int ? "/student/virtual_school/index.php" : "/StudyCourse",
        course: { subjectCode: "BIO", subjectName: "Biology", level: "6", term: "1", year: "2026" } };
      const chrome = {
        action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
        runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
        tabs: {
          query: async () => [{ id: 1, active: true, url: origin + page.path }],
          sendMessage: async (_id, message) => {
            let result;
            if (message.action === "page_version") result = { contentVersion: version };
            else if (message.action === "inspect_page") result = page;
            else if (message.action === "advance_subject") result = int
              ? { intActivity: { kind: "exam", examType: "F", enteredAt: now } }
              : { virtualFinalOpened: true, virtualAttemptId: message.virtualAttemptId, virtualAttemptEnteredAt: now };
            else if (message.action === "read_question") result = { examCode: `Q:${number}`, questionNumber: number, totalQuestions: 50, choices: [] };
            else if (message.action === "apply_answer") {
              applied.push({ number, at: now });
              result = { selected: 1, examCode: `Q:${number}`, autoAdvance: int, lastQuestion: number === 50 };
              if (int) number = number === 50 ? 1 : number + 1;
            } else if (message.action === "navigate_next") {
              result = { done: number === 50 };
              if (!result.done) number++;
            } else if (message.action === "read_submission_status") result = { submitted: false };
            else if (message.action === "submit_exam") { submissions.push(now); result = { action: "confirmed" }; }
            else throw new Error("Unexpected action " + message.action);
            return { ok: true, result };
          },
        },
      };
      runInNewContext(worker + "\nglobalThis.expose(handleRequest);", {
        chrome, WebSocket: Socket, URL, Date: Clock, console, crypto: { randomUUID: () => "attempt" },
        setInterval() {}, setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, expose: fn => { handler = fn; },
      });
      await handler("set_scope", { subjectCode: "BIO", mode: "final", autoSubmit }, port);
      await handler("set_exam_pacing", { durationMinutes: minutes }, port);
      await handler("advance_subject", {}, port);
      for (let q = 1; q <= 50; q++) {
        const due = Math.ceil(epoch + minutes * 60_000 * (q - 1) / 49);
        if (q > 1) {
          now = due - 1;
          const waiting = await handler("answer_and_next", { examCode: `Q:${q}`, choiceIndex: 1, save: int }, port);
          assert.equal(waiting.mode, "pacing");
          assert.equal(waiting.answerApplied, false);
          assert.equal(applied.length, q - 1, "no answer may be applied before its scheduled time");
        }
        now = due;
        // A slow question must not shift every later question by another fixed delay.
        if (q === 10) now += 2000;
        const answered = await handler("answer_and_next", { examCode: `Q:${q}`, choiceIndex: 1, save: int }, port);
        assert.equal(answered.answeredExamCode, `Q:${q}`);
        assert.equal(answered.done === true, q === 50);
      }
      const target = epoch + minutes * 60_000;
      assert.equal(applied.length, 50);
      assert.equal(applied[0].at, epoch);
      assert.equal(applied[49].at, target, `${origin}: last answer must target ${minutes} minutes in either submission mode`);
      assert.ok(target < epoch + 120 * 60_000);
      const result = await handler("submit_current_exam", { examCode: `Q:${number}` }, port);
      assert.equal(result.action, autoSubmit ? "confirmed" : "manual_submission_required");
      assert.equal(submissions.length, autoSubmit ? 1 : 0);
      if (autoSubmit) assert.equal(submissions[0], target);
      await assert.rejects(handler("set_exam_pacing", { durationMinutes: 120 }, port), /119/);
    }
  }
}

console.log("Target pacing passed: all 50 answer actions, 30/60/90/119-minute targets, both sites and submission modes, no early answers, slow-question recovery, and 120-minute rejection");
