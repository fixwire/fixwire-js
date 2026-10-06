// The built @fixwire/node on its own, as an app installs it (no fixwire-source
// condition, so dist/), on any Node the SDK supports: CI runs it on the oldest,
// where the TypeScript tests can't run. An error goes to a fake ingest, its
// card number masked on the way. Run after build.
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import * as Fixwire from "../packages/node/dist/index.js";

const bodies = [];
const ingest = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const gzip = req.headers["content-encoding"] === "gzip";
    bodies.push({ path: req.url, body: (gzip ? gunzipSync(raw) : raw).toString("utf8") });
    res.writeHead(200).end("{}");
  });
});
await new Promise((resolve) => ingest.listen(0, "127.0.0.1", resolve));

Fixwire.init({
  dsn: `http://smoke-key@127.0.0.1:${ingest.address().port}`,
  release: "smoke@1.0.0",
});
Fixwire.captureException(new Error("card 4111 1111 1111 1111 was declined"));
const flushed = await Fixwire.close(5000);
ingest.close();

const logs = bodies.filter((b) => b.path === "/v1/logs").map((b) => b.body);
const failures = [
  !flushed && "close() didn't flush",
  !logs.some((b) => b.includes("was declined")) && "no error reached /v1/logs",
  logs.some((b) => b.includes("4111 1111 1111 1111")) && "the card number wasn't masked",
].filter(Boolean);
if (failures.length) {
  console.error(`FAIL on Node ${process.version}: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`ok   @fixwire/node on Node ${process.version}: an error reached the ingest, masked`);
