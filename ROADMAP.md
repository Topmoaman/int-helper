# Virtual School roadmap

Planning only; these features are not included in the current release.

1. Inspect actual submitted result and review pages, including explicit correct-answer evidence and enabled retakes.
2. Parse scores and individual correct answers with text/image choices.
3. Store deduplicated verified answers in separate site/course history.
4. Reuse exact known answers in bounded batches with Virtual School's own select/next behavior.
5. Complete Normal retake/result handling and add scoped review/retry Loop behavior.
6. Add per-attempt pacing and audit subject-list workflow parity.
7. Extend tests without regressing INT, then verify an explicitly authorized live cycle before release.

Do not infer a correct choice from aggregate score or assume all Virtual School exams have 50 questions. Features depend on evidence and controls the website actually provides.
