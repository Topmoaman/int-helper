import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const worker = readFileSync(new URL("extension/service-worker.js", root), "utf8");
const version = JSON.parse(readFileSync(new URL("extension/manifest.json", root), "utf8")).version;
const port = 17373;

for (const origin of ["https://int-project.com", "https://main.virtualschool.club"]) {
  const sent = [];
  let handler, userSubmitted = false;
  const page = { origin, path: origin.includes("int-project") ? "/student/virtual_school/index.php" : "/StudyCourse",
    course: { subjectCode: "BIO", subjectName: "Biology", level: "6", term: "1", year: "2026" },
    chapters: [{ number: 1, title: "Chapter 1" }] };
  class Socket { static OPEN = 1; readyState = 1; send() {} }
  const chrome = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 1, active: true, url: origin + page.path }],
      sendMessage: async (_id, message) => {
        sent.push(message);
        if (message.action === "page_version") return { ok: true, result: { contentVersion: version } };
        if (message.action === "inspect_page") return { ok: true, result: page };
        if (message.action === "read_question") return { ok: true, result: { examCode: "Q:1", questionNumber: 1, totalQuestions: 1, choices: [] } };
        if (message.action === "read_submission_status") return { ok: true, result: { submitted: userSubmitted } };
        if (message.action === "read_exam_result") return { ok: true, result: { choices: [], score: userSubmitted ? { correct: 1, total: 1 } : null } };
        if (message.action === "advance_subject") return { ok: true, result: { mode: userSubmitted ? "chapter_complete" : "exam" } };
        if (message.action === "submit_exam") return { ok: true, result: { action: "confirmed" } };
        throw new Error("Unexpected page action " + message.action);
      },
    },
  };
  runInNewContext(worker + "\nglobalThis.expose(handleRequest);", {
    chrome, WebSocket: Socket, URL, Date, console, crypto: { randomUUID: () => "binding" },
    setInterval() {}, setTimeout, clearTimeout, expose: fn => { handler = fn; },
  });
  const setup = (mode, preference = {}) => handler("set_scope", {
    subjectCode: "BIO", mode, ...(mode === "chapter" ? { chapter: 1 } : {}), ...preference,
  }, port);
  const submit = () => handler("submit_current_exam", { examCode: "Q:1" }, port);
  for (const mode of ["chapter", "subject", "final"]) {
    for (const preference of [{}, { autoSubmit: false }, { autoSubmit: false, allowEmptyPretest: true }]) {
      const scoped = await setup(mode, preference);
      assert.equal(scoped.scope.autoSubmit, false);
      sent.length = 0;
      const waiting = await submit();
      assert.equal(waiting.mode, "awaiting_user_submission", `${origin} ${mode}`);
      assert.equal(waiting.submitted, false);
      assert.equal(sent.length, 0, "manual mode must never open or confirm a submission dialog");
    }
    await setup(mode, { autoSubmit: true });
    sent.length = 0;
    assert.equal((await submit()).action, "confirmed");
    assert.equal(sent.filter(m => m.action === "submit_exam").length, 1);
    assert.equal(sent.find(m => m.action === "submit_exam").scope.autoSubmit, true);
  }
  await setup("final", { retryUntilPerfect: true });
  assert.equal((await submit()).action, "confirmed", "an explicit Loop retains authorized submission");
  await handler("set_exam_loop", { enabled: false }, port);
  sent.length = 0;
  assert.equal((await submit()).mode, "awaiting_user_submission", "switching to Normal must not inherit Loop's submission permission");
  assert.equal(sent.length, 0);

  await setup("chapter", { autoSubmit: false });
  userSubmitted = true;
  assert.equal((await handler("read_exam_result", {}, port)).score.correct, 1, "manual submission can still be read");
  assert.equal((await handler("complete_current_lesson", {}, port)).mode, "chapter_complete", "lesson navigation can continue after the user submits");
  assert.equal(sent.filter(m => m.action === "submit_exam").length, 0);
}

console.log("Normal submission passed: explicit automatic choice, default/manual no clicks, all scope types, Loop toggle and continuation after manual submission on both sites");
