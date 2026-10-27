import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import {
  CustomEndpointStore,
  detectLocalEndpoints,
  fetchEndpointModels,
  KEYLESS_API_KEY,
  normalizeBaseUrl,
} from "../backend/custom-endpoints.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import { ModelService } from "../backend/model-service.js";
import type { CustomEndpointModel } from "../shared/custom-endpoints.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class TestEncryption implements EncryptionService {
  isAvailable(): boolean {
    return true;
  }

  encrypt(value: string): Buffer {
    return Buffer.from(value, "utf8");
  }

  decrypt(value: Buffer): string {
    return value.toString("utf8");
  }
}

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

/** An OpenAI-compatible server on loopback that lists `models` and answers every chat with "Hello". */
async function startEndpoint(
  options: { models?: unknown; route?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean } = {},
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      if (options.route?.(request, response)) return;
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: options.models ?? [{ id: "qwen2.5-coder:7b" }] }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`${chunk({ role: "assistant", content: "Hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests };
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-custom-endpoints-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createService(directory: string): Promise<ModelService> {
  const service = await ModelService.create({
    dataDirectory: directory,
    encryption: new TestEncryption(),
    allowModelNetwork: false,
    localEndpoints: [],
  });
  cleanups.push(async () => service.dispose());
  return service;
}

const QWEN: CustomEndpointModel = {
  id: "qwen2.5-coder:7b",
  contextWindow: 32_768,
  maxOutputTokens: 8_192,
  images: false,
};

/** Sends one chat through Pi, as a Wisp's session does, and returns the reply's text. */
async function chat(service: ModelService, providerId: string, modelId: string): Promise<string> {
  const runtime = service.getModelRuntime() as unknown as ModelRuntime;
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error("model not registered");
  const reply = await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
  });
  return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("normalizeBaseUrl", () => {
  it("keeps an http or https address without its trailing slash", () => {
    expect(normalizeBaseUrl(" http://127.0.0.1:11434/v1/ ")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeBaseUrl("https://llm.example.test")).toBe("https://llm.example.test");
  });

  it("refuses other schemes, credentials, queries, and fragments", () => {
    for (const value of [
      "ftp://example.test",
      "file:///etc/passwd",
      "http://user:secret@example.test/v1",
      "http://example.test/v1?key=1",
      "http://example.test/v1#x",
      "not a url",
      42,
    ]) {
      expect(normalizeBaseUrl(value)).toBeNull();
    }
  });
});

describe("CustomEndpointStore", () => {
  it("keeps the endpoints it can read and drops the rest", async () => {
    const file = path.join(await dataDirectory(), "custom-endpoints.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        endpoints: [
          { id: "custom-0a1b2c3d", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [QWEN] },
          { id: "openai", name: "Not mine", baseUrl: "http://127.0.0.1:1/v1", models: [QWEN] },
          { id: "custom-1a1b2c3d", name: "No models", baseUrl: "http://127.0.0.1:2/v1", models: [] },
        ],
      }),
    );

    expect((await new CustomEndpointStore(file).list()).map(({ id }) => id)).toEqual(["custom-0a1b2c3d"]);
  });

  it("starts empty without a file, and saves what it is given", async () => {
    const file = path.join(await dataDirectory(), "custom-endpoints.json");
    const store = new CustomEndpointStore(file);
    expect(await store.list()).toEqual([]);

    const endpoint = { id: "custom-0a1b2c3d", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [QWEN] };
    await store.save([endpoint]);

    expect(await new CustomEndpointStore(file).list()).toEqual([endpoint]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });
});

describe("fetchEndpointModels", () => {
  it("lists each valid model ID once, sorted, and sends a key only when there is one", async () => {
    const endpoint = await startEndpoint({
      models: [
        { id: "qwen2.5-coder:7b" },
        { id: "llama3.1:8b-instruct-q4_K_M" },
        { id: "has spaces" },
        { id: "qwen2.5-coder:7b" },
      ],
    });

    await expect(fetchEndpointModels(`${endpoint.url}/v1`, undefined)).resolves.toEqual([
      "llama3.1:8b-instruct-q4_K_M",
      "qwen2.5-coder:7b",
    ]);
    await fetchEndpointModels(`${endpoint.url}/v1`, "sk-test");

    expect(endpoint.requests.map(({ path, authorization }) => [path, authorization])).toEqual([
      ["/v1/models", undefined],
      ["/v1/models", "Bearer sk-test"],
    ]);
  });

  it("refuses a redirect instead of sending the key where it points", async () => {
    const elsewhere = await startEndpoint();
    const endpoint = await startEndpoint({
      route: (_request, response) => {
        response.writeHead(302, { location: `${elsewhere.url}/v1/models` }).end();
        return true;
      },
    });

    await expect(fetchEndpointModels(`${endpoint.url}/v1`, "sk-test")).rejects.toBeInstanceOf(WispBackendError);
    expect(elsewhere.requests).toEqual([]);
  });

  it("says when the key is refused, the list is not one, or no server answers", async () => {
    const refusing = await startEndpoint({
      route: (_request, response) => {
        response.writeHead(401).end();
        return true;
      },
    });
    const html = await startEndpoint({
      route: (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
        return true;
      },
    });

    await expect(fetchEndpointModels(`${refusing.url}/v1`, "sk-wrong")).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "The endpoint refused the request. Check its API key.",
    });
    await expect(fetchEndpointModels(`${html.url}/v1`, undefined)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    await expect(fetchEndpointModels(`http://127.0.0.1:${await closedPort()}/v1`, undefined)).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });
});

describe("detectLocalEndpoints", () => {
  it("reports the servers that answer with a model list", async () => {
    const ollama = await startEndpoint();
    const other = await startEndpoint({
      route: (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" }).end("not a model server");
        return true;
      },
    });

    await expect(
      detectLocalEndpoints({
        candidates: [
          { name: "Ollama", baseUrl: `${ollama.url}/v1` },
          { name: "vLLM", baseUrl: `${other.url}/v1` },
          { name: "LM Studio", baseUrl: `http://127.0.0.1:${await closedPort()}/v1` },
        ],
      }),
    ).resolves.toEqual([{ name: "Ollama", baseUrl: `${ollama.url}/v1`, models: ["qwen2.5-coder:7b"] }]);
    expect(ollama.requests.every(({ authorization }) => authorization === undefined)).toBe(true);
  });
});

describe("ModelService with custom endpoints", () => {
  it("runs a Wisp's model on an endpoint without a key", async () => {
    const endpoint = await startEndpoint();
    const service = await createService(await dataDirectory());

    const view = await service.saveCustomEndpoint({ name: "Ollama", baseUrl: `${endpoint.url}/v1`, models: [QWEN] });
    const saved = view.customEndpoints?.[0];
    expect(saved).toMatchObject({ name: "Ollama", baseUrl: `${endpoint.url}/v1`, keySaved: false, models: [QWEN] });
    expect(view.providers.find(({ id }) => id === saved?.id)).toMatchObject({
      name: "Ollama",
      credentialConfigured: true,
      models: [{ id: QWEN.id, contextWindow: 32_768, maxOutputTokens: 8_192, input: ["text"] }],
    });

    const selection = { providerId: saved!.id, modelId: QWEN.id };
    await expect(service.save({ selection })).resolves.toMatchObject({ selection });
    await expect(service.getSelection()).resolves.toEqual(selection);
    await expect(service.validateConversationSelection(selection)).resolves.toBeUndefined();
    await expect(chat(service, saved!.id, QWEN.id)).resolves.toBe("Hello");
    expect(endpoint.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
      authorization: `Bearer ${KEYLESS_API_KEY}`,
    });
    expect(JSON.parse(endpoint.requests.at(-1)!.body)).toMatchObject({ model: QWEN.id });
  });

  it("sends a saved key exactly as typed, without running or expanding it", async () => {
    const endpoint = await startEndpoint();
    const service = await createService(await dataDirectory());
    const key = "!echo pwned $HOME";

    const view = await service.saveCustomEndpoint({
      name: "Proxy",
      baseUrl: `${endpoint.url}/v1`,
      apiKey: key,
      models: [QWEN],
    });
    const id = view.customEndpoints![0]!.id;

    expect(view.customEndpoints![0]!.keySaved).toBe(true);
    expect(JSON.stringify(view)).not.toContain(key);
    await expect(chat(service, id, QWEN.id)).resolves.toBe("Hello");
    expect(endpoint.requests.at(-1)?.authorization).toBe(`Bearer ${key}`);
  });

  it("keeps endpoints and their keys after a restart", async () => {
    const endpoint = await startEndpoint();
    const directory = await dataDirectory();
    const first = await createService(directory);
    const id = (
      await first.saveCustomEndpoint({
        name: "Proxy",
        baseUrl: `${endpoint.url}/v1`,
        apiKey: "sk-saved",
        models: [QWEN],
      })
    ).customEndpoints![0]!.id;
    first.dispose();

    const second = await createService(directory);

    expect((await second.getView()).customEndpoints).toMatchObject([{ id, keySaved: true }]);
    await expect(chat(second, id, QWEN.id)).resolves.toBe("Hello");
    expect(endpoint.requests.at(-1)?.authorization).toBe("Bearer sk-saved");
  });

  it("moves a saved key to another address only when it is entered again or removed", async () => {
    const first = await startEndpoint();
    const second = await startEndpoint();
    const service = await createService(await dataDirectory());
    const id = (
      await service.saveCustomEndpoint({
        name: "Proxy",
        baseUrl: `${first.url}/v1`,
        apiKey: "sk-first",
        models: [QWEN],
      })
    ).customEndpoints![0]!.id;

    await expect(
      service.saveCustomEndpoint({ id, name: "Proxy", baseUrl: `${second.url}/v1`, models: [QWEN] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await service.saveCustomEndpoint({ id, name: "Proxy", baseUrl: `${first.url}/api/v1`, models: [QWEN] });
    const moved = await service.saveCustomEndpoint({
      id,
      name: "Proxy",
      baseUrl: `${second.url}/v1`,
      removeKey: true,
      models: [QWEN],
    });

    expect(moved.customEndpoints).toMatchObject([{ id, baseUrl: `${second.url}/v1`, keySaved: false }]);
    await chat(service, id, QWEN.id);
    expect(second.requests.at(-1)?.authorization).toBe(`Bearer ${KEYLESS_API_KEY}`);
  });

  it("loads a saved endpoint's models with its key at its own address only", async () => {
    const own = await startEndpoint();
    const other = await startEndpoint();
    const service = await createService(await dataDirectory());
    const id = (
      await service.saveCustomEndpoint({ name: "Proxy", baseUrl: `${own.url}/v1`, apiKey: "sk-own", models: [QWEN] })
    ).customEndpoints![0]!.id;

    await service.loadCustomEndpointModels({ id, baseUrl: `${own.url}/v1` });
    await service.loadCustomEndpointModels({ id, baseUrl: `${other.url}/v1` });

    expect(own.requests.at(-1)?.authorization).toBe("Bearer sk-own");
    expect(other.requests.at(-1)?.authorization).toBeUndefined();
  });

  it("removes an endpoint, its key, and a global model that used it", async () => {
    const endpoint = await startEndpoint();
    const service = await createService(await dataDirectory());
    const id = (
      await service.saveCustomEndpoint({ name: "Proxy", baseUrl: `${endpoint.url}/v1`, apiKey: "sk", models: [QWEN] })
    ).customEndpoints![0]!.id;
    await service.save({ selection: { providerId: id, modelId: QWEN.id } });

    const view = await service.removeCustomEndpoint(id);

    expect(view.selection).toBeNull();
    expect(view.customEndpoints).toEqual([]);
    expect(view.providers.map((provider) => provider.id)).not.toContain(id);
    expect(await service.listCredentialProviders()).not.toContain(id);
    await expect(service.removeCustomEndpoint(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("offers an endpoint's models as fallbacks without a key, and keeps its key out of AI Model settings", async () => {
    const endpoint = await startEndpoint();
    const service = await createService(await dataDirectory());
    const id = (await service.saveCustomEndpoint({ name: "Ollama", baseUrl: `${endpoint.url}/v1`, models: [QWEN] }))
      .customEndpoints![0]!.id;

    await expect(service.saveFallback({ selection: { providerId: id, modelId: QWEN.id } })).resolves.toMatchObject({
      fallback: { selection: { providerId: id, modelId: QWEN.id }, unavailable: null },
    });
    await expect(service.save({ selection: { providerId: id, modelId: QWEN.id }, apiKey: "sk" })).rejects.toMatchObject(
      {
        code: "invalid_request",
      },
    );
    await expect(service.removeCredential(id)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a model the endpoint was not saved with, and an output limit above the model's", async () => {
    const endpoint = await startEndpoint();
    const service = await createService(await dataDirectory());
    const id = (await service.saveCustomEndpoint({ name: "Ollama", baseUrl: `${endpoint.url}/v1`, models: [QWEN] }))
      .customEndpoints![0]!.id;

    await expect(service.save({ selection: { providerId: id, modelId: "other" } })).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    await expect(
      service.save({ selection: { providerId: id, modelId: QWEN.id, maxOutputTokens: 9_000 } }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
