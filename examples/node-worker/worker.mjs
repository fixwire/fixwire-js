// A job worker (think: a queue consumer, a cron container, an edge device).
//
//   FIXWIRE_DSN=https://<key>@<host> npm start
//
// Each job runs in its own isolation scope; failures don't stop the worker;
// with `offline` on, events captured while the network is down are kept on
// disk and sent on the next start.
import * as Fixwire from "@fixwire/node";

Fixwire.init({
  dsn: process.env.FIXWIRE_DSN,
  release: process.env.RELEASE ?? "thumbnailer@1.0.0",
  offline: process.env.FIXWIRE_OFFLINE ?? true,
  tracesSampleRate: Number(process.env.TRACES_SAMPLE_RATE ?? 1),
});

const jobs = [
  { id: "job-1", image: "cat.png", width: 320 },
  { id: "job-2", image: "dog.heic", width: 320 }, // unsupported format
  { id: "job-3", image: "bird.png", width: 0 }, // invalid input
  { id: "job-4", image: "fish.png", width: 640 },
];

async function thumbnail(job) {
  const pixels = await Fixwire.startSpan({ name: "decode", op: "image.decode" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    if (job.image.endsWith(".heic")) throw new Error(`no decoder for ${job.image}`);
    return 1024;
  });
  return Fixwire.startSpan({ name: "resize", op: "image.resize" }, () => {
    if (job.width <= 0) throw new RangeError(`width must be positive, got ${job.width}`);
    return `${job.image}@${job.width} (${pixels} px)`;
  });
}

let failed = 0;
for (const job of jobs) {
  await Fixwire.withIsolationScope(async (scope) => {
    scope.setTag("job", job.id);
    scope.setContext("job", job);
    scope.addBreadcrumb({
      category: "worker",
      message: "job started",
      timestamp: Date.now() / 1000,
    });
    // Each job is a trace of its own: a segment, with decode and resize inside.
    await Fixwire.startSpan(
      { name: "thumbnail", op: "queue.process", attributes: { "job.id": job.id } },
      async (span) => {
        try {
          console.log(`${job.id}: ${await thumbnail(job)}`);
        } catch (err) {
          failed++;
          span.setStatus("error");
          Fixwire.captureException(err);
        }
      },
    );
  });
}
if (failed) Fixwire.captureMessage(`batch finished with ${failed} failed jobs`, "warning");
await Fixwire.close(2000);
process.exitCode = failed ? 1 : 0;
