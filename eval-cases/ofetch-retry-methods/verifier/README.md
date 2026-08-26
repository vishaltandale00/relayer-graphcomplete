# Sealed verifier contract

Evaluator code builds the pinned checkout, exercises a POST explicitly allowed by `retryMethods`, checks case-insensitive matching, and verifies a disallowed GET does not retry. It requires the implementation, public type, and focused test files to change, plus a commit and clean workspace. Reasonable documentation changes are accepted; any additional files remain visible for later quality review rather than causing an undisclosed mandatory failure.
