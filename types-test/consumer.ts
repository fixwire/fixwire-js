// The public API as users write it, compiled against the built packages
// with strict settings. Each @ts-expect-error must stay an error: a type
// that loosens fails this check.
import * as Browser from "@fixwire/browser";
import { makeIndexedDbSpool } from "@fixwire/browser/offline";
import * as Edge from "@fixwire/edge";
import * as Next from "@fixwire/nextjs";
import * as NextClient from "@fixwire/nextjs/client";
import type { Breadcrumb, Event, EventHint, Integration } from "@fixwire/node";
import * as Fixwire from "@fixwire/node";
import {
  ErrorBoundary,
  type FallbackProps,
  reactErrorHandler,
  withErrorBoundary,
} from "@fixwire/react";
import * as otel from "@opentelemetry/api";
import { type ComponentType, createElement, type ReactNode } from "react";

function beforeSend(event: Event, hint: EventHint): Event | null {
  if (hint.originalException instanceof TypeError) return null;
  event.tags = { ...event.tags, checked: "yes" };
  return event;
}

const audit: Integration = { name: "Audit", setup: (client) => void client.enabled };

const client: Fixwire.Client = Fixwire.init({
  dsn: "https://fw_pk_live_key@ingest.example",
  release: "api@1.0.0",
  environment: "staging",
  beforeSend,
  beforeBreadcrumb: (crumb: Breadcrumb) => (crumb.category === "noise" ? null : crumb),
  rateLimit: { perIssueBurst: 5 },
  integrations: [audit],
  offline: true,
});
const sent: Promise<boolean> = client.flush(500);

// @ts-expect-error misspelled option
Fixwire.init({ releas: "typo" });
// @ts-expect-error unknown level
Fixwire.captureMessage("x", "warn");
// @ts-expect-error unknown event key
Fixwire.captureEvent({ mesage: "typo" });
// @ts-expect-error a score is a number
Fixwire.captureFeedback({ score: "bad" });
const feedbackId: string | undefined = Fixwire.captureFeedback({
  score: -1,
  traceId: "0af7651916cd43dd8448eb211c80319c",
});
// @ts-expect-error a breadcrumb level is a SeverityLevel
Fixwire.addBreadcrumb({ category: "cart", level: "loud" });

const id: string | undefined = Fixwire.captureException(new Error("boom"));
Fixwire.setUser({ id: 42, email: "ada@example.com", plan: "pro" });
Fixwire.addBreadcrumb({ category: "cart", message: "added sku-1", level: "info" });
const total = Fixwire.withIsolationScope((scope) => {
  scope.setTag("tenant", "acme").setLevel("warning").setFingerprint(["payments"]);
  scope.addEventProcessor((event) => (event.transaction === "GET /health" ? null : event));
  return 3;
});
const n: number = total;

// Tracing.
Fixwire.init({
  tracesSampler: ({ name, parentSampled }) => parentSampled ?? !name.startsWith("GET /health"),
  tracePropagationTargets: ["api.internal", /^https:\/\/pay\./],
});
const loaded: Promise<number> = Fixwire.startSpan(
  { name: "load order", op: "db.query", attributes: { "db.system": "postgresql", rows: 1 } },
  async (span) => {
    span.setAttribute("cache.hit", false).setStatus("ok");
    return 1;
  },
);
const job = Fixwire.startInactiveSpan({ name: "nightly", op: "task", forceSegment: true });
Fixwire.withActiveSpan(job, () => Fixwire.captureMessage("inside the job"));
job.end();
const headers: Record<string, string> = Fixwire.traceHeaders({ span: job });
const traceData: { traceparent: string; tracestate?: string } = Fixwire.getTraceData();
const meta: string = Fixwire.getTraceMetaTags();
const checkInId: string | undefined = Fixwire.captureCheckIn(
  { monitorSlug: "nightly-report", status: "in_progress" },
  { schedule: { type: "interval", value: 1, unit: "day" }, maxRuntime: 30 },
);
Fixwire.captureCheckIn({ monitorSlug: "nightly-report", status: "ok", checkInId, duration: 1.5 });
// @ts-expect-error a check-in's status is in_progress, ok or error
Fixwire.captureCheckIn({ monitorSlug: "nightly-report", status: "done" });
Fixwire.withIsolationScope(() => Fixwire.continueTrace(new Headers({ traceparent: "00-…" })));
// @ts-expect-error a span status is "ok" or "error"
job.setStatus("cancelled");
// @ts-expect-error attribute values are strings, numbers or booleans
job.setAttribute("bad", { nested: true });
Browser.init({
  tracesSampleRate: 0.2,
  integrations: [Browser.browserTracingIntegration({ idleTimeout: 500 })],
});

// AI agent tracing.
interface FakeMessage {
  id: string;
  content: { type: "tool_use"; id: string; name: string; input: { id: string } }[];
}
const anthropic = Fixwire.wrapAnthropic({
  messages: {
    create: async (_params: { model: string; max_tokens: number }): Promise<FakeMessage> => ({
      id: "m",
      content: [],
    }),
  },
});
const answer: Promise<string> = Fixwire.ai.agent(
  { name: "support-bot", provider: "anthropic", model: "claude-opus-5-5", conversationId: "c-1" },
  async (run) => {
    const msg: FakeMessage = await anthropic.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 512,
    });
    for (const block of msg.content) {
      await Fixwire.ai.tool({ name: block.name, callId: block.id, arguments: block.input }, (t) =>
        t.setResult("ok"),
      );
    }
    await Fixwire.ai.chat({ provider: "openai", model: "gpt-x", maxTokens: 100 }, async (call) => {
      call.setResponse({ finishReasons: ["stop"], usage: { inputTokens: 10, outputTokens: 2 } });
    });
    run.setOutput("done");
    return "done";
  },
);
// @ts-expect-error a chat span needs a provider and a model
Fixwire.ai.chat({ model: "gpt-x" }, () => {});
Fixwire.init({ recordAiContent: true });

// React.
const fallback = ({ error, eventId, resetError }: FallbackProps): ReactNode =>
  createElement(
    "button",
    { type: "button", onClick: resetError },
    `${String(error)} (${eventId ?? "not sent"})`,
  );
const boundary = createElement(ErrorBoundary, {
  fallback,
  beforeCapture: (scope) => scope.setTag("area", "cart"),
});
const Cart: ComponentType<{ items: number }> = ({ items }) => createElement("p", null, items);
const SafeCart: ComponentType<{ items: number }> = withErrorBoundary(Cart, { fallback: "oops" });
const onUncaughtError: (error: unknown, info: { componentStack?: string }) => void =
  reactErrorHandler();
// @ts-expect-error the wrapped component keeps its props
createElement(SafeCart, { item: 1 });

// Next.js instrumentation.ts.
export const onRequestError: (
  error: unknown,
  request: Fixwire.NextRequestInfo,
  context: Fixwire.NextErrorContext,
) => Promise<void> = Fixwire.captureRequestError;

// @fixwire/nextjs: one import in every runtime.
Next.init({ tracesSampleRate: 0.2, filterNoise: true, useEnvironment: true });
export const onNextRequestError: (
  error: unknown,
  request: Next.NextRequestInfo,
  context: Next.NextErrorContext,
) => Promise<void> = Next.captureRequestError;
export const onRouterTransitionStart: (url: string, navigationType: string) => void =
  Next.onRouterTransitionStart;
const nextConfig: { reactStrictMode: boolean } = Next.withFixwireConfig({ reactStrictMode: true });
const nextConfigFn = Next.withFixwireConfig(async (phase: string) => ({ distDir: phase }));
NextClient.init({ integrations: [Next.browserTracingIntegration()] });
const ErrorPage = ({ error }: { error: Error & { digest?: string } }): ReactNode => {
  Next.useCaptureException(error);
  return null;
};
// @ts-expect-error misspelled option
Next.init({ tracesSampelRate: 1 });

const handler: Fixwire.ExpressErrorHandler = Fixwire.expressErrorHandler();
Browser.init({ dsn: "https://fw_pk_live_key@ingest.example", offline: makeIndexedDbSpool });
const browser: Browser.Client = Browser.init({
  dsn: "https://fw_pk_live_key@ingest.example",
  filterNoise: false,
});

// The app's own OpenTelemetry: linked, never replaced.
const otelLinked: Integration = Fixwire.openTelemetryIntegration(otel);
const otlpTraces: { url: string; headers: Record<string, string> } = Fixwire.otlpExporterOptions(
  "https://fw_pk_live_key@ingest.eu.fixwire.io",
).traces;

// A serverless handler keeps its signature.
const lambda = Fixwire.wrapHandler(async (event: { id: string }, _ctx: object) => ({
  ok: event.id,
}));
const lambdaResult: Promise<{ ok: string }> = lambda({ id: "1" }, {});
// @ts-expect-error the event's type is kept
lambda({ nope: 1 }, {});

// A Workers module keeps its type: a typed env, the full ExecutionContext.
interface Env {
  FIXWIRE_DSN: string;
  KV: { get(key: string): Promise<string | null> };
}
interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
const worker = Edge.withFixwire((env: Env) => ({ dsn: env.FIXWIRE_DSN, tracesSampleRate: 0.2 }), {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    ctx.passThroughOnException();
    return new Response(await env.KV.get(request.url));
  },
});
const workerResponse: Promise<Response> = worker.fetch(
  new Request("https://w.example/"),
  {} as Env,
  {
    waitUntil: () => {},
    passThroughOnException: () => {},
  },
);
// A middleware's extra arguments are kept.
const middleware = Edge.wrapRequestHandler(
  async (request: Request, _event: { waitUntil(p: Promise<unknown>): void }) =>
    new Response(request.url),
  { flushTimeoutMs: 1000 },
);
const middlewareResponse: Promise<Response> = middleware(new Request("https://w.example/"), {
  waitUntil: () => {},
});

export {
  answer,
  boundary,
  browser,
  checkInId,
  ErrorPage,
  feedbackId,
  handler,
  headers,
  id,
  lambdaResult,
  loaded,
  meta,
  middlewareResponse,
  n,
  nextConfig,
  nextConfigFn,
  onUncaughtError,
  otelLinked,
  otlpTraces,
  sent,
  traceData,
  workerResponse,
};
