// Runs a built page in Node with just enough of a browser: a window that
// receives "error" and "unhandledrejection" events, a location, buttons,
// and a fetch that fails for the page's own relative URLs. Clicks the
// buttons named on the command line, then waits for delivery.
//
//   node page.mjs <bundle.js> '#add' '#checkout' …
import { pathToFileURL } from "node:url";

const [bundle, ...clicks] = process.argv.slice(2);
const window = new EventTarget();

class Button {
  textContent = "";
  handlers = [];
  addEventListener(_type, fn) {
    this.handlers.push(fn);
  }
  click() {
    for (const fn of this.handlers) fn(new Event("click"));
  }
}
const buttons = new Map();

globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.location = {
  href: "https://shop.example.com/?ref=mail",
  origin: "https://shop.example.com",
  pathname: "/",
};
globalThis.document = {
  // Vite's module-preload polyfill asks; say modulepreload is supported.
  createElement: () => ({ relList: { supports: () => true } }),
  querySelectorAll: () => [],
  querySelector: (sel) => {
    if (sel.startsWith("meta")) return null; // no server-rendered trace here
    if (!buttons.has(sel)) buttons.set(sel, new Button());
    return buttons.get(sel);
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  String(url).startsWith("http")
    ? realFetch(url, init)
    : Promise.reject(new TypeError("Failed to fetch"));

// What a browser does with exceptions in handlers and unhandled rejections.
process.on("unhandledRejection", (reason) =>
  window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason })),
);

await import(pathToFileURL(bundle).href);
for (const sel of clicks) {
  try {
    buttons.get(sel)?.click();
  } catch (error) {
    window.dispatchEvent(Object.assign(new Event("error"), { error, message: String(error) }));
  }
}
await new Promise((r) => setTimeout(r, 100)); // let async handlers settle
window.dispatchEvent(new Event("pagehide")); // the user leaves: the page-load trace is sent
const ok = await globalThis.__FIXWIRE__.client.flush(5000);
process.exit(ok ? 0 : 1);
