import * as Fixwire from "@fixwire/browser";
import { makeIndexedDbSpool } from "@fixwire/browser/offline";

Fixwire.init({
  dsn: import.meta.env.FIXWIRE_DSN || undefined,
  release: "example-browser-vite@0.0.0", // matches `npm run sourcemaps`
  environment: import.meta.env.MODE,
  // Flaky mobile networks: keep events in IndexedDB until they're sent.
  offline: makeIndexedDbSpool,
  // Page loads, route changes and fetch calls, as traces (opt-in: pages
  // that only report errors don't ship this code).
  tracesSampleRate: 1,
  integrations: [Fixwire.browserTracingIntegration()],
});
Fixwire.setUser({ id: "u-42" });
Fixwire.setTag("page", "shop");

const status = (text) => {
  document.querySelector("#status").textContent = text;
};

const cart = { items: [] };

document.querySelector("#add").addEventListener("click", () => {
  // A bug: reported by the global handlers, the stack mapped back to this
  // file once source maps are uploaded.
  cart.items.push({ sku: "sku-1", price: cart.discount.amount });
});

document.querySelector("#checkout").addEventListener("click", async () => {
  // Nobody awaits this promise: an unhandled rejection, reported as such.
  submitOrder();
  status("Submitting…");
});

async function submitOrder() {
  await new Promise((r) => setTimeout(r, 10));
  throw new Error("order service rejected the cart of ada@example.com");
}

document.querySelector("#handled").addEventListener("click", () => {
  try {
    applyCoupon("WELCOME10");
  } catch (err) {
    Fixwire.withScope((scope) => {
      scope.setContext("coupon", { code: "WELCOME10" });
      scope.setLevel("warning");
      Fixwire.captureException(err);
    });
    status("That coupon has expired.");
  }
});

function applyCoupon(code) {
  throw new Error(`coupon ${code} expired`);
}

document.querySelector("#api").addEventListener("click", async () => {
  // The failed request shows up as a breadcrumb on the error that follows.
  const res = await fetch("/api/recommendations").catch(() => null);
  if (!res?.ok) Fixwire.captureMessage("recommendations unavailable", "warning");
});
