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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
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
  const url = `http://127.0.0.1:${options.port}`;
  const server: Server = {
    url,
    output: () => out,
    stop: async () => {
      if (!exited) child.kill("SIGTERM");
      await gone;
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

/** Chromium (the headless shell), from the workspace's Playwright. */
export async function chromium() {
  const { chromium } = await import("playwright");
  return chromium.launch();
}
