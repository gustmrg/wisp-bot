import { createHash } from "node:crypto";

/** Playwright's version in the browser image; its Chromium comes with it, so the two always match. */
export const PLAYWRIGHT_VERSION = "1.64.0";

/**
 * The Wisp browser image, built on the server from this file the first time a
 * Wisp opens a page. It holds Playwright and its headless Chromium, and none
 * of the sandbox image's tools. Its tag is derived from the contents.
 */
export const BROWSER_DOCKERFILE = `FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
    ca-certificates fonts-liberation fonts-noto-cjk fonts-noto-color-emoji nodejs npm \\
 && mkdir -p /opt/wisp-browser \\
 && cd /opt/wisp-browser \\
 && npm install --no-audit --no-fund --omit=dev playwright-core@${PLAYWRIGHT_VERSION} \\
 && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \\
 && npm cache clean --force \\
 && rm -rf /var/lib/apt/lists/*
`;

export const BROWSER_IMAGE = `wisp-browser:${createHash("sha256").update(BROWSER_DOCKERFILE).digest("hex").slice(0, 12)}`;

/**
 * The driver, run with Node as the browser container's only process. It reads
 * one JSON request per line on standard input and answers each with one JSON
 * line on standard output, so the server reaches it without any port: the
 * container needs no address the server can connect to, and a Wisp whose
 * local network is blocked keeps a network with no route out.
 *
 * It launches headless Chromium on the first request, keeps one page (a page
 * the site opens becomes the current one), and exits when its input ends, so
 * the container goes with the server's process. Downloads are refused and
 * dialogs dismissed. `WISP_BROWSER_PROXY` names the egress proxy for a Wisp
 * whose local network is blocked.
 */
export const BROWSER_DRIVER_SCRIPT = String.raw`"use strict";
const readline = require("node:readline");
const { chromium } = require("/opt/wisp-browser/node_modules/playwright-core");

const NAVIGATION_TIMEOUT = 30000;
const ACTION_TIMEOUT = 10000;
const PROXY = process.env.WISP_BROWSER_PROXY || "";

let browser = null;
let context = null;
let page = null;
const notes = [];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function current() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      ...(PROXY ? { proxy: { server: PROXY } } : {}),
      args: ["--disable-dev-shm-usage"],
    });
    context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(ACTION_TIMEOUT);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    context.on("page", (opened) => {
      page = opened;
      watch(opened);
    });
  }
  if (!page || page.isClosed()) {
    page = context.pages().filter((open) => !open.isClosed()).at(-1) || (await context.newPage());
  }
  return page;
}

function watch(target) {
  target.on("dialog", (dialog) => {
    notes.push("The page showed a " + dialog.type() + " dialog, which was dismissed: " + dialog.message().slice(0, 300));
    dialog.dismiss().catch(() => undefined);
  });
  target.on("download", (download) => {
    notes.push("The page started a download (" + download.suggestedFilename() + "), which was refused.");
  });
}

/** Lets a page finish what an action started, without waiting on pages that never go quiet. */
async function settle(target) {
  await target.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT }).catch(() => undefined);
  await target.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => undefined);
}

async function state(target, withSnapshot) {
  const result = { url: target.url(), title: await target.title().catch(() => ""), notes: notes.splice(0) };
  if (withSnapshot) result.snapshot = await target.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT });
  return result;
}

/** Fails at once for a ref the page no longer has, rather than when the action times out. */
async function element(target, ref) {
  const locator = target.locator("aria-ref=" + ref);
  if ((await locator.count().catch(() => 0)) === 0) {
    throw new Error("No element has the ref " + ref + " on this page. Take a new snapshot and use its refs.");
  }
  return locator;
}

/** What an element is, so the server can tell a link from a button that sends a form before acting on it. */
async function describe(target, ref) {
  return (await element(target, ref)).evaluate((inner) => {
    // A click on something inside a button or a link acts on that button or link.
    const node = inner.closest("button, input, select, textarea, [role='button'], a[href]") || inner;
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute("type") || "").toLowerCase();
    const role = (node.getAttribute("role") || "").toLowerCase();
    const form = node.form || node.closest("form");
    const label = (
      node.getAttribute("aria-label") ||
      node.innerText ||
      node.value ||
      node.getAttribute("title") ||
      node.getAttribute("placeholder") ||
      node.getAttribute("name") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    let kind = "other";
    if (tag === "input" && type === "password") kind = "password";
    else if (
      (tag === "button" && type !== "button" && type !== "reset" && form) ||
      (tag === "input" && (type === "submit" || type === "image"))
    )
      kind = "submit";
    else if (tag === "button" || role === "button" || (tag === "input" && (type === "button" || type === "reset")))
      kind = "button";
    else if (node.closest("a[href]")) kind = "link";
    else if (tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable) kind = "field";
    return {
      kind,
      label,
      url: location.href,
      form: form
        ? {
            method: (form.getAttribute("method") || "get").toLowerCase(),
            password: Boolean(form.querySelector('input[type="password"]')),
          }
        : null,
    };
  }, undefined, { timeout: ACTION_TIMEOUT });
}

async function handle(request) {
  const target = await current();
  switch (request.action) {
    case "open":
      if (!/^https?:\/\//i.test(request.url || "")) throw new Error("Only http and https addresses can be opened.");
      await target.goto(request.url, { waitUntil: "domcontentloaded" });
      await settle(target);
      return state(await current(), true);
    case "snapshot":
      return state(target, true);
    case "describe":
      return describe(target, request.ref);
    case "click":
      await (await element(target, request.ref)).click();
      await settle(await current());
      return state(await current(), true);
    case "type": {
      const field = await element(target, request.ref);
      await field.fill(request.text);
      if (request.submit) {
        await field.press("Enter");
        await settle(await current());
      }
      return state(await current(), true);
    }
    case "select":
      await (await element(target, request.ref)).selectOption(request.values);
      await settle(target);
      return state(await current(), true);
    case "back":
      await target.goBack({ waitUntil: "domcontentloaded" });
      await settle(target);
      return state(await current(), true);
    case "wait":
      await target.waitForTimeout(Math.min(Math.max(Number(request.seconds) || 1, 1), 30) * 1000);
      return state(target, true);
    case "screenshot": {
      const image = await target.screenshot({ type: "jpeg", quality: 70, fullPage: Boolean(request.fullPage) });
      return { ...(await state(target, false)), image: image.toString("base64") };
    }
    default:
      throw new Error("Unknown browser action.");
  }
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(() =>
    handle(request).then(
      (result) => send({ id: request.id, ok: true, result }),
      (error) => send({ id: request.id, ok: false, error: String((error && error.message) || error).split("\n")[0] }),
    ),
  );
});
input.on("close", () => {
  // After the requests already sent, which the server may still be waiting on.
  queue
    .then(() => (browser ? browser.close() : undefined))
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
send({ ready: true });
`;

export const BROWSER_DRIVER_SCRIPT_HASH = createHash("sha256").update(BROWSER_DRIVER_SCRIPT).digest("hex").slice(0, 12);
