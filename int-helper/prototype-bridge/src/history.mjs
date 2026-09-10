import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const normalize = (value) => (value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
const content = (item) => JSON.stringify([normalize(item.text), item.image || null]);
const questionKey = (q) => createHash("sha256").update(JSON.stringify([
  normalize(q.questionText), q.questionImage || null, q.choices.map(content).sort(),
])).digest("hex");

// One file per MCP session avoids concurrent writers and survives plugin upgrades.
export const createHistory = (directory = process.env.INT_PRACTICE_HISTORY_DIR || join(homedir(), ".local", "share", "int-practice-helper", "history"), scope = null) => {
  const subject = Object.fromEntries(["origin", "subjectCode", "subjectName", "level", "term", "year"].map(key => [key, normalize(scope?.[key]) || null]));
  const identified = ["origin", "subjectCode", "level", "term", "year"].every(key => subject[key]);
  const subjectKey = identified ? createHash("sha256").update(JSON.stringify(subject)).digest("hex") : null;
  const name = (subject.subjectName || subject.subjectCode || "unassigned").replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "_").slice(0, 60);
  directory = join(directory, subjectKey ? `${name}-${subjectKey}` : "unassigned");
  const file = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`);
  const append = (record) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({ ...record, subject, subjectKey, recordedAt: new Date().toISOString(), version: 2 }) + "\n", { encoding: "utf8", mode: 0o600 });
  };
  const rememberReview = (review) => {
    append({ type: "review_evidence", result: review });
    if (!["INT explicit correct-answer label", "INT submitted answer-sheet marker"].includes(review.verificationSource)) return;
    if (review.verificationSource === "INT submitted answer-sheet marker" &&
        (review.correctness !== "correct" || review.correctChoiceIndex !== review.selectedChoiceIndex)) return;
    const choice = review.choices.find((c) => c.index === review.correctChoiceIndex);
    if (!choice || (!review.questionText && !review.questionImage)) return;
    // Keep per-attempt evidence in the journal, but do not append the same verified answer again.
    const known = lookup(review);
    if (known?.choiceIndex === choice.index) return;
    append({ type: "verified_answer", questionKey: questionKey(review), question: {
      questionText: review.questionText, questionImage: review.questionImage, choices: review.choices,
    }, correctChoice: choice, selectedChoiceIndex: review.selectedChoiceIndex, correctness: review.correctness,
    sourceUrl: review.url, sourceExamCode: review.examCode, evidence: review.evidence });
  };
  const rejectAnswer = (review) => {
    if (review.verificationSource !== "INT submitted answer-sheet marker" || review.correctness !== "incorrect") return;
    const choice = review.choices?.find(c => c.index === review.selectedChoiceIndex);
    if (!choice) return;
    append({ type: "rejected_answer", questionKey: questionKey(review), rejectedChoice: choice, evidence: review.evidence });
  };
  const bankFile = join(directory, "answer-bank.json");
  const cache = new Map();
  let index = null, stems = new Set(), evidenceTotals = {};
  const stemKey = (q) => JSON.stringify([normalize(q.questionText), q.questionImage || null]);
  const statsSnapshot = () => {
    const types = {}, observed = new Set();
    for (const entry of cache.values()) {
      for (const [type, count] of Object.entries(entry.types)) types[type] = (types[type] || 0) + count;
      for (const key of entry.observed) observed.add(key);
    }
    return { bankFile, historyFile: file, subject, questionReadRecords: types.question || 0,
      answerSavedRecords: types.answer_returned || 0, uniqueObservedQuestions: observed.size,
      verifiedRecords: types.verified_answer || 0, ...evidenceTotals,
      usableAnswers: [...(index?.values() || [])].filter(e => e.answers.size === 1).length,
      conflicts: [...(index?.values() || [])].filter(e => e.answers.size > 1).length };
  };
  const writeBank = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const snapshot = { version: 1, subject, subjectKey, updatedAt: new Date().toISOString(),
      stats: statsSnapshot(), entries: [...index].filter(([, entry]) => entry.question).map(([key, entry]) => ({
        questionKey: key, question: entry.question, status: entry.answers.size === 1 ? "verified" : entry.answers.size ? "conflict" : "rejected",
        answers: [...entry.answers.values()].map(r => ({ correctChoice: r.correctChoice, evidence: r.evidence, sourceUrl: r.sourceUrl, recordedAt: r.recordedAt })),
      })) };
    const temporary = bankFile + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(snapshot) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, bankFile);
  };
  const refresh = () => {
    let files;
    try { files = readdirSync(directory).filter(f => f.endsWith(".jsonl")).sort(); }
    catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
    let changed = !index;
    for (const name of files) {
      const path = join(directory, name), stat = statSync(path), signature = `${stat.size}:${stat.mtimeMs}`;
      if (cache.get(name)?.signature === signature) continue;
      const records = [], types = {}, observed = new Set(), digest = createHash("sha256");
      for (const line of readFileSync(path, "utf8").split("\n")) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.subjectKey !== subjectKey) continue;
        types[r.type] = (types[r.type] || 0) + 1;
        if (r.type === "question" && r.question?.choices?.length) observed.add(questionKey(r.question));
        if (!["verified_answer", "rejected_answer"].includes(r.type)) continue;
        digest.update(line);
        records.push({ ...r, matchKey: r.question ? questionKey(r.question) : r.questionKey });
      }
      const evidenceSignature = digest.digest("hex");
      if (cache.get(name)?.evidenceSignature !== evidenceSignature) changed = true;
      cache.set(name, { signature, evidenceSignature, records, types, observed });
    }
    for (const name of cache.keys()) if (!files.includes(name)) { cache.delete(name); changed = true; }
    if (!changed) return;
    const records = [...cache.values()].flatMap(entry => entry.records).sort((a,b) => a.recordedAt.localeCompare(b.recordedAt));
    const aliases = new Map(records.filter(r => r.question).map(r => [r.questionKey, r.matchKey]));
    index = new Map(); stems = new Set();
    const verifiedKeys = new Set(), verifiedPairs = new Set(); let verifiedCount = 0;
    for (const r of records) {
      const key = r.type === "rejected_answer" ? aliases.get(r.questionKey) || r.matchKey : r.matchKey;
      if (!index.has(key)) index.set(key, { answers: new Map(), question: null });
      const entry = index.get(key);
      if (r.question) { entry.question = r.question; stems.add(stemKey(r.question)); }
      if (r.type === "verified_answer" && r.correctChoice) {
        entry.answers.set(content(r.correctChoice), r);
        verifiedCount++; verifiedKeys.add(key); verifiedPairs.add(JSON.stringify([key, content(r.correctChoice)]));
      }
      if (r.type === "rejected_answer" && r.rejectedChoice) entry.answers.delete(content(r.rejectedChoice));
    }
    evidenceTotals = { uniqueVerifiedQuestions: verifiedKeys.size, duplicateVerifiedRecords: verifiedCount - verifiedPairs.size };
    if (subjectKey && records.length) writeBank();
  };
  const lookupDetailed = (question) => {
    const miss = reason => ({ answer: null, reason });
    if (!subjectKey) return miss("subject_unidentified");
    if (!question.choices?.length || (!question.questionText && !question.questionImage)) return miss("question_incomplete");
    refresh();
    const entry = index.get(questionKey(question));
    if (!entry) return miss(stems.has(stemKey(question)) ? "different_choices" : "no_verified_match");
    if (!entry.answers.size) return miss("answer_rejected");
    if (entry.answers.size !== 1) return miss("conflicting_evidence");
    const [identity, record] = [...entry.answers][0];
    const matches = question.choices.filter(c => content(c) === identity);
    if (matches.length !== 1) return miss("ambiguous_choice");
    return { reason: "verified_match", answer: { choiceIndex: matches[0].index, correctness: "verified", evidence: record.evidence, sourceUrl: record.sourceUrl } };
  };
  const lookup = question => lookupDetailed(question).answer;
  const stats = () => { refresh(); if (subjectKey) writeBank(); return statsSnapshot(); };
  return { file, bankFile, subject, append, rememberReview, rejectAnswer, lookup, lookupDetailed, stats };
};
