# Node worker

```sh
FIXWIRE_DSN=https://<key>@<host> pnpm --filter example-node-worker start
```

Four jobs, two failures: each is reported with its own `job` tag, job context
and breadcrumbs (`withIsolationScope` per job), then a summary warning. The
worker exits 1 when jobs failed. The offline queue (on here) keeps events on
disk when the network is down and sends them on the next start.

Each job is also a trace (`startSpan` with `op: "queue.process"`) with
`decode` and `resize` spans inside; failed jobs are marked, and each error
links to its job's trace.
