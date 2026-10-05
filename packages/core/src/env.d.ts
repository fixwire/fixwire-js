// The few globals the runtime-agnostic core uses; every supported runtime
// (browsers, Node, workers, edge) has them.
declare const console: { warn(...args: unknown[]): void };
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare function setTimeout(fn: () => void, ms?: number): unknown;
declare function clearTimeout(timer: unknown): void;
