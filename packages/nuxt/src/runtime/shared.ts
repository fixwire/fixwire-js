// What the runtime plugins share: the module's options as runtime config
// gives them, and the options a fixwire.*.config file adds.
import type { ClientOptions } from "@fixwire/core";

/** `runtimeConfig.public.fixwire`: the module's options, strings left empty when unset. */
export interface RuntimeSettings {
  dsn?: string;
  release?: string;
  environment?: string;
  attachProps?: boolean;
  [key: string]: unknown;
}

/** What a fixwire.client.config or fixwire.server.config file exports. */
export type ConfigExport<O> = O | (() => O);

/**
 * The SDK's options: runtime config's (empty strings read as unset), then
 * the config file's, which win. Returns them and attachProps apart.
 */
export function settings<O extends ClientOptions>(
  runtime: RuntimeSettings | undefined,
  file: ConfigExport<O> | undefined,
): { options: O; attachProps: boolean } {
  const { attachProps, ...rest } = runtime ?? {};
  const fromRuntime: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== "" && v !== undefined) fromRuntime[k] = v;
  const own = typeof file === "function" ? file() : file;
  return { options: { ...fromRuntime, ...own } as O, attachProps: attachProps === true };
}
