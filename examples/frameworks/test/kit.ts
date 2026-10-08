// What the framework examples' tests share: pack the SDK's packages as npm
// publishes them, install an example app with them in a scratch directory
// (as a user would, from tarballs instead of the registry), build it, start
// it, and drive Chromium through it.
//
// Run `pnpm build` first: the tarballs carry dist. FIXWIRE_EXAMPLES_TMP
// sets where the apps are installed (default: the system's temp directory).
import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

import { type Json, thrown } from "../../../packages/core/test/helpers.ts";
import type { Ingest } from "../../test/ingest.ts";

const root = resolve(import.meta.dirname, "../../..");
const scratch = (): string => {
  const base = process.env.FIXWIRE_EXAMPLES_TMP || tmpdir();
  mkdirSync(base, { recursive: true });
  return base;
};

/** Runs a command; resolves with its output, rejects with it when it fails. */
export function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      out += c;
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`${command} ${args.join(" ")} exited ${code}:\n${out}`)),
    );
  });
}

let packed: Promise<Record<string, string>> | undefined;

/** Packs every package once: their names and tarball paths. */
export function pack(): Promise<Record<string, string>> {
  packed ??= (async () => {
    const out = mkdtempSync(join(scratch(), "fixwire-packages-"));
    const tarballs: Record<string, string> = {};
    for (const dir of readdirSync(join(root, "packages"))) {
      const pkg = join(root, "packages", dir);
      if (!existsSync(join(pkg, "dist")))
        throw new Error(`packages/${dir} has no dist: run pnpm build first`);
      const { name } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
      // pnpm writes the workspace:* versions out, as the release does.
      const result = await run("pnpm", ["pack", "--pack-destination", out, "--json"], { cwd: pkg });
      tarballs[name] = resolve(out, JSON.parse(result.slice(result.indexOf("{"))).filename);
    }
    return tarballs;
  })();
  return packed;
}

/**
 * Copies examples/frameworks/<name> into a scratch directory and installs
 * it with npm: its @fixwire/* dependencies, and theirs, come from the
 * tarballs; `@fixwire/cli` from the registry. Returns the app's directory.
 */
export async function install(name: string): Promise<string> {
  const tarballs = await pack();
  const dir = join(mkdtempSync(join(scratch(), `fixwire-${name}-`)), name);
  cpSync(join(root, "examples/frameworks", name), dir, {
    recursive: true,
    filter: (src) =>
      !/[/\\](node_modules|\.next|\.nuxt|\.output|\.svelte-kit|\.angular|dist|build)$/.test(src),
  });
  const file = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const local = Object.fromEntries(
    Object.entries(tarballs).map(([n, path]) => [n, `file:${path}`]),
  );
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const n of Object.keys(deps ?? {})) {
      if (local[n]) deps[n] = local[n];
      // The CLI isn't part of this workspace: the newest release.
      else if (n === "@fixwire/cli") deps[n] = "latest";
    }
  }
  pkg.overrides = { ...pkg.overrides, ...local };
  writeFileSync(file, JSON.stringify(pkg, null, 2));
  await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
  return dir;
}

/**
 * Runs fixwire-cli in an app: the binary FIXWIRE_CLI names (one built from
 * this repository's cli/, say), or the release npm installed with the app.
 */
export function cli(dir: string, args: string[]): Promise<string> {
  const bin = process.env.FIXWIRE_CLI;
  return bin ? run(bin, args, { cwd: dir }) : run("npx", ["fixwire-cli", ...args], { cwd: dir });
}

/** A free TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

export interface Server {
  url: string;
  /** What the server printed so far. */
  output(): string;
  stop(): Promise<void>;
}

/** Starts a server and resolves once it answers HTTP on `port`. */
export async function serve(
  command: string,
  args: string[],
  options: { cwd: string; port: number; env?: Record<string, string>; timeoutMs?: number },
): Promise<Server> {
  // A process group of its own (but on Windows), so stopping it stops the
  // processes it starts too: a server left behind holds the output pipes,
  // and the test never ends.
  const group = process.platform !== "win32";
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: group,
  });
  let out = "";
  child.stdout?.on("data", (c) => {
    out += c;
  });
  child.stderr?.on("data", (c) => {
    out += c;
  });
  let exited = false;
  const gone = new Promise<void>((done) =>
    child.on("exit", () => {
      exited = true;
      done();
    }),
  );
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (group && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // already gone
    }
  };
  const url = `http://127.0.0.1:${options.port}`;
  const server: Server = {
    url,
    output: () => out,
    stop: async () => {
      if (!exited) signal("SIGTERM");
      const late = setTimeout(() => signal("SIGKILL"), 5000);
      await gone;
      clearTimeout(late);
      if (group) signal("SIGKILL"); // what the server started, if it outlived it
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    if (exited) throw new Error(`${command} ${args.join(" ")} exited:\n${out}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return server;
    } catch {
      if (Date.now() > deadline) {
        await server.stop();
        throw new Error(`${url} never answered:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/**
 * Serves a static build (a single-page app: unknown paths get index.html)
 * on `port`; `api` answers what it takes on, such as a failing endpoint.
 */
export async function serveStatic(
  dir: string,
  port: number,
  api?: (request: IncomingMessage, response: ServerResponse) => boolean,
): Promise<Server> {
  const root = resolve(dir);
  const server = createHttpServer((request, response) => {
    if (api?.(request, response)) return;
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    let file = normalize(join(root, path));
    if (!file.startsWith(root) || !existsSync(file) || !/\.[a-z0-9]+$/i.test(file))
      file = join(root, "index.html");
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${port}`,
    output: () => "",
    stop: () => new Promise((done) => server.close(() => done())),
  };
}

/** Chromium (the headless shell), from the workspace's Playwright. */
export async function chromium() {
  const { chromium } = await import("playwright");
  return chromium.launch();
}

/** The error events whose exception message includes `text`. */
export const errors = (sink: Ingest, text: string): Json[] =>
  sink.events().filter((e) => e.eventName === "exception" && thrown(e)?.message?.includes(text));

/** Waits for the error event whose message includes `text`. */
export async function reported(sink: Ingest, text: string): Promise<Json> {
  const [event] = await sink.until(() => {
    const got = errors(sink, text);
    return got.length ? got : undefined;
  });
  return event as Json;
}

/**
 * Checks a build's JavaScript files that fixwire-cli stamped: each has a
 * debug id, and its map (named by its sourceMappingURL, or next to it) the
 * same one. Returns how many there are.
 */
export function stampedFiles(dir: string): number {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.m?js$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  walk(dir);
  let stamped = 0;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const map =
      /\/\/# sourceMappingURL=(\S+)\s*$/m.exec(code)?.[1] ?? `${file.split(/[\\/]/).at(-1)}.map`;
    if (!existsSync(join(file, "..", map))) continue;
    const id = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1];
    if (!id) throw new Error(`${file} has a source map but no debug id`);
    // debug_id, or the standard's debugId alone (Rolldown keeps only that).
    const parsed = JSON.parse(readFileSync(join(file, "..", map), "utf8"));
    const mapped = parsed.debug_id ?? parsed.debugId;
    if (mapped !== id) throw new Error(`${file}: debug id ${id}, its map's ${mapped}`);
    stamped++;
  }
  return stamped;
}
