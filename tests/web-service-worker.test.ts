import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

/** Runs the real service worker against an in-memory cache and a network that is down. */
async function startOffline() {
  const source = await readFile(path.join(process.cwd(), "web/public/sw.js"), "utf8");
  const listeners = new Map<string, Listener>();
  const added: string[] = [];
  const stored = new Map<string, Response>();
  const cache = {
    addAll: async (urls: string[]) => {
      added.push(...urls);
      for (const url of urls) stored.set(url, new Response(url));
    },
    put: async () => undefined,
  };
  const self = {
    location: { origin: "https://wisp.invalid" },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
  };
  vm.runInNewContext(source, {
    self,
    URL,
    Response,
    Promise,
    setTimeout,
    caches: {
      open: async () => cache,
      match: async (request: string | { url: string }) =>
        stored.get(typeof request === "string" ? request : new URL(request.url).pathname),
    },
    fetch: () => Promise.reject(new Error("The network is down.")),
  });
  let installed: Promise<unknown> = Promise.resolve();
  listeners.get("install")!({ waitUntil: (work: Promise<unknown>) => (installed = work) });
  await installed;

  return {
    added,
    /** What the worker answers for a page's file, or undefined when it leaves it to the network. */
    async fetchFile(pathname: string): Promise<Response | undefined> {
      let answer: Promise<Response> | undefined;
      listeners.get("fetch")!({
        request: { method: "GET", mode: "no-cors", url: `https://wisp.invalid${pathname}` },
        respondWith: (response: Promise<Response>) => (answer = response),
      });
      return answer;
    },
  };
}

describe("web service worker", () => {
  it("shows the splash's icon with no network", async () => {
    const worker = await startOffline();
    expect(worker.added).toContain("/apple-touch-icon.png");
    const response = await worker.fetchFile("/apple-touch-icon.png");
    expect(await response?.text()).toBe("/apple-touch-icon.png");
  });

  it("leaves API responses out of the cache", async () => {
    const worker = await startOffline();
    expect(await worker.fetchFile("/api/conversations")).toBeUndefined();
  });
});
