/**
 * Serverless functions on Node (AWS Lambda, Google Cloud Functions, Azure
 * Functions, Netlify and Vercel functions): the platform may freeze or stop
 * the process as soon as a handler returns, losing events still queued.
 * wrapHandler runs each invocation in its own isolation scope, traces it as
 * a segment named after the function, reports an error it throws (and
 * throws it on), and flushes before returning.
 *
 *   import * as Fixwire from "@fixwire/node";
 *   Fixwire.init({ dsn: process.env.FIXWIRE_DSN });
 *   export const handler = Fixwire.wrapHandler(async (event, context) => { … });
 *
 * Async handlers only (callback-style Lambda handlers are deprecated).
 */
import { getClient, startSpan, withIsolationScope } from "@fixwire/core";

/** Options of wrapHandler(). */
export interface WrapHandlerOptions {
  /**
   * The longest wait for queued events before returning (default 2000 ms).
   * On AWS Lambda the wait also stays 500 ms inside the time left.
   */
  flushTimeoutMs?: number;
  /** The segment's name (default: the Lambda function's name, else the handler's). */
  name?: string;
}

/** The parts of an AWS Lambda context the wrapper reads. */
interface LambdaContext {
  functionName: string;
  functionVersion?: string;
  awsRequestId?: string;
  invokedFunctionArn?: string;
  getRemainingTimeInMillis?: () => number;
}

function lambdaContext(v: unknown): LambdaContext | undefined {
  const c = v as Partial<LambdaContext> | null | undefined;
  return c && typeof c === "object" && typeof c.functionName === "string"
    ? (c as LambdaContext)
    : undefined;
}

/**
 * Wraps a serverless handler: its own scope, a segment, errors reported,
 * and a flush before it returns.
 */
export function wrapHandler<A extends unknown[], R>(
  handler: (...args: A) => R | Promise<R>,
  options: WrapHandlerOptions = {},
): (...args: A) => Promise<Awaited<R>> {
  const flushTimeout = options.flushTimeoutMs ?? 2000;
  return async (...args: A): Promise<Awaited<R>> => {
    const lambda = lambdaContext(args[1]);
    const name = options.name ?? lambda?.functionName ?? (handler.name || "handler");
    try {
      return await withIsolationScope(async (scope) => {
        const endSession = getClient()?.startRequestSession(scope);
        scope.setTag("serverless.function", name);
        if (lambda) {
          scope.setContext("aws_lambda", {
            function_name: lambda.functionName,
            function_version: lambda.functionVersion,
            aws_request_id: lambda.awsRequestId,
            invoked_function_arn: lambda.invokedFunctionArn,
          });
        }
        try {
          return await startSpan(
            { name, op: lambda ? "function.aws.lambda" : "function" },
            async () => {
              try {
                return (await handler(...args)) as Awaited<R>;
              } catch (e) {
                getClient()?.captureException(e, {
                  mechanism: { type: "serverless", handled: false },
                });
                throw e;
              }
            },
          );
        } finally {
          endSession?.();
        }
      });
    } finally {
      let wait = flushTimeout;
      const left = lambda?.getRemainingTimeInMillis?.();
      if (typeof left === "number") wait = Math.max(0, Math.min(wait, left - 500));
      if (wait > 0) await getClient()?.flush(wait);
    }
  };
}
