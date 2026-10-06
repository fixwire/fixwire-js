// The few globals the runtime-agnostic core uses; every supported runtime
// (browsers, Node, workers, edge) has them.
declare const console: { warn(...args: unknown[]): void };
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class URL {
  constructor(url: string, base?: string);
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly origin: string;
}
declare function setTimeout(fn: () => void, ms?: number): unknown;
declare function clearTimeout(timer: unknown): void;
