// Only exact, verified matches can be applied. This bounded helper never submits.
// INT's Save action uses true; Virtual School selects in place and advances with
// save=false. Keep true as the default for the existing INT callers.
export const answerKnownQuestions = async ({ read, answer, maxQuestions = 10, save = true, stillAuthorized = () => true, now = Date.now }) => {
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 20) throw new Error("maxQuestions must be 1–20");
  if (typeof save !== "boolean") throw new Error("save must be boolean");
  const started = now();
  let result = await read(), applied = 0;
  const finish = reason => ({ ...result, knownAnswersApplied: applied, batchStopReason: reason });
  while (applied < maxQuestions && now() - started < 12000) {
    if (!stillAuthorized()) throw new Error("History scope changed during verified-answer batch");
    if (result.done) return finish("exam_answered");
    if (!result.verifiedAnswer) return finish("needs_reasoning");
    if (result.verifiedAnswer.correctness !== "verified" || !result.choices?.some(c => c.index === result.verifiedAnswer.choiceIndex)) throw new Error("Verified choice is not present in the current question");
    result = await answer({ examCode: result.examCode, choiceIndex: result.verifiedAnswer.choiceIndex, save });
    if (["resync", "pacing", "verified_answer_available"].includes(result.mode)) return finish(result.mode);
    if (result.selected === undefined) return finish("answer_not_confirmed");
    applied++;
    if (result.historyWarning) return finish("history_warning");
  }
  return finish(result.done ? "exam_answered" : "batch_limit");
};
