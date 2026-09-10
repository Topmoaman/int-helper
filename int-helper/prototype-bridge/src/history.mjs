import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const VIRTUAL_ORIGIN = "https://main.virtualschool.club";
const VIRTUAL_EXPLICIT_SOURCE = "Virtual School explicit correct-answer label";
const INT_EXPLICIT_SOURCE = "INT explicit correct-answer label";
const INT_SHEET_SOURCE = "INT submitted answer-sheet marker";
const VIRTUAL_LEDGER_SOURCE = "bound_attempt_ledger";

const normalize = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const normalizeImage = (value) => {
  const normalized = normalize(value);
  return normalized || null;
};
const content = (item = {}) => JSON.stringify([normalize(item.text), normalizeImage(item.image)]);
const questionKey = (q = {}) => createHash("sha256").update(JSON.stringify([
  normalize(q.questionText), normalizeImage(q.questionImage), (q.choices || []).map(content).sort(),
])).digest("hex");

const isVirtual = (origin) => normalize(origin) === VIRTUAL_ORIGIN;
const identityFields = (virtual) => virtual
  ? ["origin", "subjectCode", "level", "term", "year"]
  : ["origin", "subjectCode", "subjectName", "level", "term", "year"];
const courseFields = ["origin", "subjectCode", "level", "term", "year"];

const scopedSubject = (scope) => {
  const subject = Object.fromEntries(["origin", "subjectCode", "subjectName", "level", "term", "year"]
    .map((key) => [key, normalize(scope?.[key]) || null]));
  const virtual = isVirtual(subject.origin);
  const identified = courseFields.every((key) => subject[key]);
  // INT's existing key includes subjectName and must remain byte-for-byte
  // compatible. Virtual School's display name is a label, not course identity.
  const identity = virtual
    ? Object.fromEntries(courseFields.map((key) => [key, subject[key]]))
    : subject;
  const subjectKey = identified ? createHash("sha256").update(JSON.stringify(identity)).digest("hex") : null;
  return { subject, virtual, identified, identity, subjectKey };
};

const sameCourse = (recordSubject, subject, virtual) => {
  if (!recordSubject || !subject) return false;
  const fields = virtual ? courseFields : identityFields(false);
  return fields.every((key) => normalize(recordSubject[key]) === subject[key]);
};

const acceptedRecord = (record, virtual) => {
  if (!virtual) return true;
  if (record.type === "verified_answer") return record.verificationSource === VIRTUAL_EXPLICIT_SOURCE;
  if (record.type === "rejected_answer") {
    const selected = record.question?.choices?.find((choice) => choice.index === record.selectedChoiceIndex);
    const correct = record.question?.choices?.find((choice) => choice.index === record.correctChoiceIndex);
    return record.verificationSource === VIRTUAL_EXPLICIT_SOURCE && record.selectionSource === VIRTUAL_LEDGER_SOURCE &&
      record.correctness === "incorrect" && selected && correct && selected.index !== correct.index &&
      content(selected) === content(record.rejectedChoice);
  }
  return true;
};

const safeName = (value) => normalize(value).replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "_").slice(0, 60);

// One file per MCP session avoids concurrent writers and survives plugin upgrades.
export const createHistory = (directory = process.env.INT_PRACTICE_HISTORY_DIR || join(homedir(), ".local", "share", "int-practice-helper", "history"), scope = null) => {
  const metadata = scopedSubject(scope);
  const { subject, virtual, identified, subjectKey } = metadata;
  // A Virtual directory is keyed by subjectCode so adding the observed display
  // name later keeps the canonical path stable. INT retains its old naming.
  const name = safeName(virtual ? subject.subjectCode : (subject.subjectName || subject.subjectCode || "unassigned"));
  const rootDirectory = directory;
  const journalDirectory = join(rootDirectory, subjectKey ? `${name}-${subjectKey}` : "unassigned");
  const file = join(journalDirectory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`);

  const append = (record) => {
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({ ...record, subject, subjectKey, recordedAt: new Date().toISOString(), version: 2 }) + "\n", { encoding: "utf8", mode: 0o600 });
  };

  const rememberReview = (review) => {
    append({ type: "review_evidence", result: review });
    const source = review.verificationSource;
    const explicit = source === INT_EXPLICIT_SOURCE || source === VIRTUAL_EXPLICIT_SOURCE;
    const sheet = source === INT_SHEET_SOURCE;
    if (!explicit && !sheet) return;
    if (virtual ? source !== VIRTUAL_EXPLICIT_SOURCE : source === VIRTUAL_EXPLICIT_SOURCE) return;
    if (sheet && (review.correctness !== "correct" || review.correctChoiceIndex !== review.selectedChoiceIndex)) return;
    const choice = review.choices?.find((candidate) => candidate.index === review.correctChoiceIndex);
    if (!choice || (!review.questionText && !review.questionImage)) return;
    // Keep per-attempt evidence in the journal, but do not append the same
    // verified answer again. lookup() remaps the answer through this review's
    // current choice order, including image-only choices.
    const known = lookup(review);
    if (known?.choiceIndex === choice.index) return;
    append({ type: "verified_answer", questionKey: questionKey(review), question: {
      questionText: review.questionText, questionImage: review.questionImage, choices: review.choices,
    }, correctChoice: choice, selectedChoiceIndex: review.selectedChoiceIndex, correctness: review.correctness,
    verificationSource: source, sourceUrl: review.url, sourceExamCode: review.examCode, evidence: review.evidence });
  };

  const rejectAnswer = (review) => {
    const intSheet = review.verificationSource === INT_SHEET_SOURCE && review.correctness === "incorrect";
    const virtualCorrection = review.verificationSource === VIRTUAL_EXPLICIT_SOURCE &&
      review.correctness === "incorrect" && review.selectionSource === VIRTUAL_LEDGER_SOURCE;
    if (virtual ? !virtualCorrection : !intSheet) return;
    const selected = review.choices?.find((candidate) => candidate.index === review.selectedChoiceIndex);
    // An unknown selected answer cannot prove that any particular historical
    // choice was wrong. In particular, Virtual's explicit label may coexist
    // with selectedChoiceIndex=null.
    if (!selected) return;
    if ((!review.questionText && !review.questionImage) || !review.choices?.length) return;
    if (virtualCorrection) {
      const correct = review.choices.find((candidate) => candidate.index === review.correctChoiceIndex);
      if (!correct || correct.index === selected.index) return;
    }
    const correct = review.choices.find((candidate) => candidate.index === review.correctChoiceIndex);
    append({ type: "rejected_answer", questionKey: questionKey(review), question: {
      questionText: review.questionText, questionImage: review.questionImage, choices: review.choices,
    }, rejectedChoice: selected, selectedChoiceIndex: review.selectedChoiceIndex,
    correctChoiceIndex: review.correctChoiceIndex, correctChoice: correct, correctness: review.correctness,
    verificationSource: review.verificationSource, selectionSource: review.selectionSource, evidence: review.evidence });
  };

  const bankFile = join(journalDirectory, "answer-bank.json");
  const cache = new Map();
  let index = null;
  let stems = new Set();
  let evidenceTotals = {};

  // A Virtual course may have journals written before subjectName was known.
  // Read every direct child journal directory and filter by the exact stable
  // course fields. Raw files are never moved, renamed or deleted. INT keeps its
  // original single-directory lookup to preserve its existing identity layout.
  const journalFiles = () => {
    const directories = new Set([journalDirectory]);
    if (virtual && identified) {
      directories.add(rootDirectory);
      try {
        for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.add(join(rootDirectory, entry.name));
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const files = [];
    for (const currentDirectory of directories) {
      let names;
      try { names = readdirSync(currentDirectory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const currentName of names) if (currentName.endsWith(".jsonl")) files.push(join(currentDirectory, currentName));
    }
    return files.sort();
  };

  const statsSnapshot = () => {
    const types = {}, observed = new Set();
    for (const entry of cache.values()) {
      for (const [type, count] of Object.entries(entry.types)) types[type] = (types[type] || 0) + count;
      for (const key of entry.observed) observed.add(key);
    }
    return { bankFile, historyFile: file, subject, questionReadRecords: types.question || 0,
      answerSavedRecords: types.answer_returned || 0, uniqueObservedQuestions: observed.size,
      verifiedRecords: types.verified_answer || 0, ...evidenceTotals,
      usableAnswers: [...(index?.values() || [])].filter((entry) => entry.answers.size === 1).length,
      conflicts: [...(index?.values() || [])].filter((entry) => entry.answers.size > 1).length };
  };

  const writeBank = () => {
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    const snapshot = { version: 1, subject, subjectKey, updatedAt: new Date().toISOString(),
      stats: statsSnapshot(), entries: [...(index || new Map())].filter(([, entry]) => entry.question).map(([key, entry]) => ({
        questionKey: key, question: entry.question, status: entry.answers.size === 1 ? "verified" : entry.answers.size ? "conflict" : "rejected",
        answers: [...entry.answers.values()].map((record) => ({ correctChoice: record.correctChoice, evidence: record.evidence, sourceUrl: record.sourceUrl, recordedAt: record.recordedAt })),
      })) };
    const temporary = bankFile + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(snapshot) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, bankFile);
  };

  const refresh = () => {
    const files = identified ? journalFiles() : [];
    let changed = !index;
    for (const path of files) {
      const stat = statSync(path);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (cache.get(path)?.signature === signature) continue;
      const records = [], types = {}, observed = new Set(), digest = createHash("sha256");
      for (const line of readFileSync(path, "utf8").split("\n")) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!sameCourse(record.subject, subject, virtual) || !acceptedRecord(record, virtual)) continue;
        types[record.type] = (types[record.type] || 0) + 1;
        if (record.type === "question" && record.question?.choices?.length) observed.add(questionKey(record.question));
        if (!["verified_answer", "rejected_answer"].includes(record.type)) continue;
        digest.update(line);
        records.push({ ...record, matchKey: record.question ? questionKey(record.question) : record.questionKey });
      }
      const evidenceSignature = digest.digest("hex");
      if (cache.get(path)?.evidenceSignature !== evidenceSignature) changed = true;
      cache.set(path, { signature, evidenceSignature, records, types, observed });
    }
    for (const path of cache.keys()) if (!files.includes(path)) { cache.delete(path); changed = true; }
    if (!changed) return;

    const records = [...cache.values()].flatMap((entry) => entry.records).sort((a, b) => String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")));
    const aliases = new Map(records.filter((record) => record.question).map((record) => [record.questionKey, record.matchKey]));
    index = new Map();
    stems = new Set();
    const verifiedKeys = new Set(), verifiedPairs = new Set();
    let verifiedCount = 0;
    for (const record of records) {
      const key = record.type === "rejected_answer" ? aliases.get(record.questionKey) || record.matchKey : record.matchKey;
      if (!key) continue;
      if (!index.has(key)) index.set(key, { answers: new Map(), question: null });
      const entry = index.get(key);
      if (record.question) { entry.question = record.question; stems.add(JSON.stringify([normalize(record.question.questionText), normalizeImage(record.question.questionImage)])); }
      if (record.type === "verified_answer" && record.correctChoice) {
        entry.answers.set(content(record.correctChoice), record);
        verifiedCount += 1;
        verifiedKeys.add(key);
        verifiedPairs.add(JSON.stringify([key, content(record.correctChoice)]));
      }
      if (record.type === "rejected_answer" && record.rejectedChoice) entry.answers.delete(content(record.rejectedChoice));
    }
    evidenceTotals = { uniqueVerifiedQuestions: verifiedKeys.size, duplicateVerifiedRecords: verifiedCount - verifiedPairs.size };
    if (subjectKey && records.length) writeBank();
  };

  const lookupDetailed = (question) => {
    const miss = (reason) => ({ answer: null, reason });
    if (!subjectKey) return miss("subject_unidentified");
    if (!question.choices?.length || (!question.questionText && !question.questionImage)) return miss("question_incomplete");
    refresh();
    const key = questionKey(question);
    const entry = index.get(key);
    if (!entry) return miss(stems.has(JSON.stringify([normalize(question.questionText), normalizeImage(question.questionImage)]))
      ? "different_choices" : "no_verified_match");
    if (!entry.answers.size) return miss("answer_rejected");
    if (entry.answers.size !== 1) return miss("conflicting_evidence");
    const [identity, record] = [...entry.answers][0];
    const matches = question.choices.filter((choice) => content(choice) === identity);
    if (matches.length !== 1) return miss("ambiguous_choice");
    return { reason: "verified_match", answer: { choiceIndex: matches[0].index, correctness: "verified", evidence: record.evidence, sourceUrl: record.sourceUrl } };
  };

  const lookup = (question) => lookupDetailed(question).answer;
  const stats = () => { refresh(); if (subjectKey) writeBank(); return statsSnapshot(); };
  return { file, bankFile, subject, subjectKey, append, rememberReview, rejectAnswer, lookup, lookupDetailed, stats };
};
