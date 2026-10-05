# Upstream

A hard fork: we don't merge upstream, we cherry-pick fixes by hand.

| Upstream path (getsentry/sentry-javascript @ ec4931e, 11.4.0) | Ported into |
|---|---|
| packages/browser/src/stack-parsers.ts | packages/browser/src/stack-parsers.ts |
| packages/core/src/utils/stacktrace.ts | packages/core/src/stacktrace.ts |
| packages/core/src/utils/node-stack-trace.ts | packages/core/src/node-stack-trace.ts |

```sh
git -C sentry-javascript log --oneline ec4931e..HEAD -- packages/browser/src/stack-parsers.ts
```
