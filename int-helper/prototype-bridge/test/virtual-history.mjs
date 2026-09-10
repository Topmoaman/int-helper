import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHistory } from "../src/history.mjs";
import { answerKnownQuestions } from "../src/known-answers.mjs";

const source = "Virtual School explicit correct-answer label";
const virtualScope = { origin: "https://main.virtualschool.club", subjectCode: "BIO-22", level: "J", term: "2", year: "2569" };
const question = {
  questionText: "  Which image is a cell?  ",
  questionImage: "https://main.virtualschool.club/question_pic/q.png",
  choices: [
    { index: 1, text: "A", image: "https://main.virtualschool.club/answers_pic/a.png" },
    { index: 2, text: "B", image: "https://main.virtualschool.club/answers_pic/b.png" },
  ],
};

const folder = mkdtempSync(join(tmpdir(), "virtual-history-"));
try {
  const history = createHistory(folder, virtualScope);
  // Virtual accepts the explicit correct label even when the submitted choice
  // is unknown. Reordering choices remaps the saved image/text identity.
  history.rememberReview({ ...question, correctChoiceIndex: 2, selectedChoiceIndex: null,
    correctness: "unverified", verificationSource: source, evidence: "คำตอบที่ถูกต้อง ข" });
  const shuffled = { ...question, choices: [
    { ...question.choices[1], index: 1 },
    { ...question.choices[0], index: 2 },
  ] };
  assert.equal(history.lookup(shuffled).choiceIndex, 1);
  history.rememberReview({ ...shuffled, correctChoiceIndex: 1, selectedChoiceIndex: null,
    correctness: "unverified", verificationSource: source });
  assert.equal(history.stats().verifiedRecords, 1, "same image/text answer in a new order is deduplicated");
  history.rememberReview({ ...question, correctChoiceIndex: 1, verificationSource: "INT explicit correct-answer label" });
  assert.equal(history.stats().verifiedRecords, 1, "a different site's evidence label is not Virtual evidence");
  assert.equal(history.lookup(question).choiceIndex, 2, "a wrong evidence source cannot create a Virtual conflict");
  const intHistory = createHistory(folder, { origin: "https://int-project.com", subjectCode: virtualScope.subjectCode,
    subjectName: "Biology", level: virtualScope.level, term: virtualScope.term, year: virtualScope.year });
  intHistory.rememberReview({ ...question, correctChoiceIndex: 2, verificationSource: source });
  assert.equal(intHistory.stats().verifiedRecords, 0, "Virtual evidence cannot enter an INT bank");
} finally {
  rmSync(folder, { recursive: true, force: true });
}

const correctionFolder = mkdtempSync(join(tmpdir(), "virtual-correction-"));
try {
  const history = createHistory(correctionFolder, virtualScope);
  history.rememberReview({ ...question, correctChoiceIndex: 1, selectedChoiceIndex: null,
    verificationSource: source, correctness: "unverified" });
  // Unknown selected choice does not invalidate an arbitrary historical answer.
  history.rejectAnswer({ ...question, selectedChoiceIndex: null, correctness: "incorrect",
    verificationSource: source, selectionSource: "bound_attempt_ledger" });
  assert.equal(history.lookup(question).choiceIndex, 1);
  history.rejectAnswer({ ...question, selectedChoiceIndex: 1, correctness: "incorrect",
    verificationSource: source, selectionSource: "untrusted_history" });
  assert.equal(history.lookup(question).choiceIndex, 1);
  history.rejectAnswer({ ...question, selectedChoiceIndex: 1, correctChoiceIndex: 1, correctness: "incorrect",
    verificationSource: source, selectionSource: "bound_attempt_ledger" });
  assert.equal(history.lookup(question).choiceIndex, 1, "a correction must identify a different explicit correct choice");
  history.rejectAnswer({ ...question, selectedChoiceIndex: 1, correctChoiceIndex: 2, correctness: "incorrect",
    verificationSource: source, selectionSource: "bound_attempt_ledger" });
  assert.equal(history.lookup(question), null);
  history.rememberReview({ ...question, correctChoiceIndex: 2, selectedChoiceIndex: null,
    verificationSource: source, correctness: "unverified" });
  assert.equal(history.lookup(question).choiceIndex, 2, "new explicit answer repairs a bound wrong selection");
} finally {
  rmSync(correctionFolder, { recursive: true, force: true });
}

// A legacy pre-name Virtual journal is readable without moving or deleting its
// raw file. The canonical directory/key is unchanged when the display name is
// added, while a different term remains isolated.
const legacyFolder = mkdtempSync(join(tmpdir(), "virtual-legacy-"));
try {
  const legacySubject = { origin: virtualScope.origin, subjectCode: virtualScope.subjectCode, subjectName: null,
    level: virtualScope.level, term: virtualScope.term, year: virtualScope.year };
  const legacyKey = createHash("sha256").update(JSON.stringify(legacySubject)).digest("hex");
  const legacyDirectory = join(legacyFolder, `${virtualScope.subjectCode}-${legacyKey}`);
  mkdirSync(legacyDirectory, { recursive: true });
  const legacyFile = join(legacyDirectory, "old-attempt.jsonl");
  writeFileSync(legacyFile, JSON.stringify({ type: "verified_answer", questionKey: "legacy-key", question,
    correctChoice: question.choices[1], verificationSource: source, subject: legacySubject, subjectKey: legacyKey,
    recordedAt: "2026-01-01T00:00:00.000Z" }) + "\n");
  const named = createHistory(legacyFolder, { ...virtualScope, subjectName: "Biology" });
  const unnamed = createHistory(legacyFolder, virtualScope);
  assert.equal(named.subjectKey, unnamed.subjectKey);
  assert.equal(named.lookup({ ...question, choices: [
    { ...question.choices[1], index: 1 },
    { ...question.choices[0], index: 2 },
  ] }).choiceIndex, 1);
  assert.equal(readFileSync(legacyFile, "utf8").includes("Virtual School explicit correct-answer label"), true);
  assert.equal(readdirSync(legacyFolder).includes(legacyDirectory.split("/").at(-1)), true);
  assert.equal(createHistory(legacyFolder, { ...virtualScope, term: "1", subjectName: "Biology" }).lookup(question), null);
  assert.equal(createHistory(legacyFolder, { ...virtualScope, origin: "https://int-project.com", subjectName: "Biology" }).lookup(question), null);
  assert.equal(createHistory(legacyFolder).lookup(question), null);
} finally {
  rmSync(legacyFolder, { recursive: true, force: true });
}

const knownQuestion = { examCode: "V:1", questionNumber: 1, choices: question.choices,
  verifiedAnswer: { correctness: "verified", choiceIndex: 2 } };
const calls = [];
const unknown = await answerKnownQuestions({
  save: false,
  read: async () => knownQuestion,
  answer: async (payload) => { calls.push(payload); return { examCode: "V:2", questionNumber: 2,
    choices: [{ index: 1, text: "new", image: null }], selected: payload.choiceIndex, done: false }; },
});
assert.equal(calls[0].save, false, "Virtual known batches select without INT Save semantics");
assert.equal(unknown.knownAnswersApplied, 1);
assert.equal(unknown.batchStopReason, "needs_reasoning");
const done = await answerKnownQuestions({
  save: false,
  read: async () => knownQuestion,
  answer: async (payload) => ({ examCode: payload.examCode, selected: payload.choiceIndex, done: true }),
});
assert.equal(done.knownAnswersApplied, 1);
assert.equal(done.batchStopReason, "exam_answered");
await assert.rejects(answerKnownQuestions({ save: false, read: async () => knownQuestion,
  answer: async () => { throw new Error("must not answer after scope change"); }, stillAuthorized: () => false }), /scope changed/);

console.log("Virtual history passed: explicit labels, image remapping, unknown-selection correction, legacy subject identity, site/year isolation and save=false bounded batches");
