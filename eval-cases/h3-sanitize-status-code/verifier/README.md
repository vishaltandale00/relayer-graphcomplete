# Sealed verifier

The code-owned `h3-status-code-v2` verifier is implemented by `gradeH3Workspace`.
It applies the candidate's committed patch to a pristine verifier workspace,
runs evaluator-owned behavior checks against the public sanitizer boundary,
then separately records focused regression and delivery evidence. Candidate
source text and candidate-selected test literals are never acceptance criteria.

The behavior suite covers lower and upper integer boundaries, decimal numbers,
integer numeric strings, decimal numeric strings, and custom fallback values.
The regression suite runs the focused sanitizer tests, build, and typecheck.
Delivery receipts retain changed-file scope, requested commit history, and final
tree cleanliness. The candidate receives none of the evaluator-owned checks
before its autonomous turn completes.
