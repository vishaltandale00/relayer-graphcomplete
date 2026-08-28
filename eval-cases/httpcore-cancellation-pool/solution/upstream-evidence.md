# Upstream grounding

The immutable fixture is encode/httpcore commit
`79fa6bf0dfcf3820d1ae7e52a2d268f33022c5a4`, tree
`834aaf7041c78aa49597e691e6ce9fc41d6c0bc6`. It reports version 1.0.2,
declares Python 3.8–3.12 support, and carries the BSD-3-Clause license.

Primary upstream evidence:

- [Issue #785](https://github.com/encode/httpcore/issues/785) records cancellation
  during connection setup leaving the pool unable to serve later requests.
- [The upstream diagnosis](https://github.com/encode/httpcore/issues/785#issuecomment-1702406690)
  describes a half-created `AsyncHTTPConnection` that is neither available nor
  expired and therefore retains a pool slot.
- [PR #880](https://github.com/encode/httpcore/pull/880) closes #785 and reworks
  cancellation handling. Its merge commit is
  `7b04cda582b32cba34a7bfb0eb1dd535f0ea88a5`.
- [Release 1.0.3](https://github.com/encode/httpcore/releases/tag/1.0.3)
  identifies #880 as the async-cancellation fix.

The verifier intentionally does not compare candidate source with PR #880 or
with any reference patch. It observes only the public `AsyncConnectionPool`,
`AsyncNetworkBackend`, request, response, connection-list, and close seams.
