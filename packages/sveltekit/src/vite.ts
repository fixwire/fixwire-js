/**
 * The Vite plugin for SvelteKit apps: the client build's chunks are stamped
 * with debug ids while Vite writes them, before the adapter copies,
 * compresses and lists them (adapter-node records each file's size when it
 * builds, so files stamped afterwards are served cut short).
 *
 *   // vite.config.ts
 *   import { fixwireSvelteKit } from "@fixwire/sveltekit/vite";
 *   export default defineConfig({
 *     build: { sourcemap: "hidden" },
 *     plugins: [fixwireSvelteKit(), sveltekit({ adapter: adapter() })],
 *   });
 *
 * Then `fixwire-cli sourcemaps upload --delete build/client` uploads them.
 */
import { createHash } from "node:crypto";

/** Options of fixwireSvelteKit. */
export interface FixwireSvelteKitOptions {
  /** Stamp the client build with debug ids when it has source maps (default true). */
  debugIds?: boolean;
}

interface ChunkLike {
  type: "chunk";
  fileName: string;
  code: string;
  map?: { mappings: string } | null;
}

interface AssetLike {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}

/** What Fixwire's plugin is, as Vite (5 to 8) sees it. */
export interface FixwireVitePlugin {
  name: string;
  apply: "build";
  enforce: "post";
  configResolved(config: { build: { ssr?: unknown } }): void;
  generateBundle(
    this: unknown,
    options: unknown,
    bundle: Record<string, ChunkLike | AssetLike>,
  ): void;
}

// The snippet and ids fixwire-cli stamps (protocol/PROTOCOL.md §10).
const snippet = (id: string): string =>
  `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:typeof window!=="undefined"?window:` +
  `typeof self!=="undefined"?self:{};var s=new g.Error().stack;if(s){g._fixwireDebugIds=g._fixwireDebugIds||{};` +
  `g._fixwireDebugIds[s]="${id}"}}catch(e){}})();`;

/** A UUID (version 4 layout) from the chunk's content, as fixwire-cli derives it. */
export function debugIdFor(content: string): string {
  const b = createHash("sha256").update(content).digest().subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const MAP_URL = /\n\/\/[#@] sourceMappingURL=\S+\s*$/;

/**
 * Stamps each chunk that has a source map: the snippet on a line of its own
 * before the code (the map's lines move down by one, nothing else changes)
 * and a `//# debugId=` comment, which goes before a sourceMappingURL one.
 * Chunks with a directive prologue or a hashbang (which must stay first) or
 * stamped before are left alone. Returns how many it stamped.
 */
export function stampBundle(bundle: Record<string, ChunkLike | AssetLike>): number {
  let stamped = 0;
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk" || /^\s*(#!|["'])/.test(chunk.code)) continue;
    if (/^\/\/# debugId=/m.test(chunk.code)) continue;
    const asset = bundle[`${chunk.fileName}.map`];
    const mapAsset = asset?.type === "asset" ? asset : undefined;
    if (!chunk.map && !mapAsset) continue;
    const id = debugIdFor(chunk.code);
    const url = MAP_URL.exec(chunk.code);
    const body = url ? chunk.code.slice(0, url.index) : chunk.code;
    const end = body.endsWith("\n") ? "" : "\n";
    chunk.code = `${snippet(id)}\n${body}${end}//# debugId=${id}${url ? url[0] : "\n"}`;
    if (chunk.map)
      Object.assign(chunk.map, { mappings: `;${chunk.map.mappings}`, debug_id: id, debugId: id });
    if (mapAsset) {
      const map = JSON.parse(String(Buffer.from(mapAsset.source)));
      mapAsset.source = JSON.stringify({
        ...map,
        mappings: `;${map.mappings}`,
        debug_id: id,
        debugId: id,
      });
    }
    stamped++;
  }
  return stamped;
}

/** Fixwire's Vite plugin for SvelteKit: debug ids in the client build. */
export function fixwireSvelteKit(options: FixwireSvelteKitOptions = {}): FixwireVitePlugin {
  let ssr = false;
  return {
    name: "fixwire:sveltekit",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      ssr = !!config.build.ssr;
    },
    generateBundle(_options, bundle) {
      if (options.debugIds === false) return;
      // Vite 6 and newer build each environment with the same plugins.
      const consumer = (this as { environment?: { config?: { consumer?: string } } } | undefined)
        ?.environment?.config?.consumer;
      if (consumer ? consumer !== "client" : ssr) return;
      stampBundle(bundle);
    },
  };
}
