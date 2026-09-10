# Virtual School status and roadmap

Version 0.19.0 implements separate website adapters, opaque subject-card selection, structured submitted-modal scores, explicit correct-answer extraction, final-only verified history, exact known-answer batches, per-attempt pacing and scoped final review/retry with variable question totals. Combined simulated regressions cover these contracts and preserve INT behavior.

Remaining work:

1. Extend reusable Virtual history to chapter/posttest reviews with equally strong current-attempt binding. These reviews are currently readable but do not populate that bank.
2. Maintain fixtures when the learning platform changes its DOM, labels or navigation.

Normal completes one attempt and reports its result. Virtual Loop requires an explicit final-only request and complete bound review evidence before retrying. Historical/aggregate-only reviews cannot create reusable answers or authorize a retry. Full scores are compared against the observed question total; Virtual exams are not assumed to contain 50 questions.
