import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.env.WISP_PI_SMOKE !== "1") {
  console.error("Live Pi smoke is disabled. Set WISP_PI_SMOKE=1 explicitly to enable it.");
  process.exitCode = 2;
} else {
  await run();
}

async function run() {
  const providerId = required("WISP_PI_SMOKE_PROVIDER");
  const modelId = required("WISP_PI_SMOKE_MODEL");
  const apiKey = required("WISP_PI_SMOKE_API_KEY");
  const smokeDirectory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-live-"));
  let agent;
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { PiConversationAgent, SdkPiSessionFactory } = await import(
      "../dist-electron/electron/backend/pi-conversation-agent.js"
    );
    const workspaceDirectory = path.join(smokeDirectory, "workspace");
    const sessionDirectory = path.join(smokeDirectory, "sessions");
    const configDirectory = path.join(smokeDirectory, "config");
    await Promise.all([
      mkdir(workspaceDirectory, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
    ]);
    const runtime = await ModelRuntime.create({
      authPath: path.join(smokeDirectory, "runtime-auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(smokeDirectory, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey(providerId, apiKey);
    agent = new PiConversationAgent(
      {
        conversationId: "live-smoke",
        sessionId: "live-smoke-session",
        name: "Live Smoke Wisp",
        label: "Verification",
        description: "Verifies one environment-gated Pi request.",
        workspaceDirectory,
        sessionDirectory,
        configDirectory,
        piSessionId: null,
        piSessionFile: null,
        savePiSessionIdentity: async () => undefined,
      },
      new SdkPiSessionFactory(runtime),
      { flushDelayMs: 20 },
    );
    const eventTypes = [];
    agent.subscribe((event) => eventTypes.push(event.type));
    await agent.start();
    await agent.applyModel({ providerId, modelId });
    await agent.send({
      conversationId: "live-smoke",
      requestId: "live-smoke-request",
      text: "Reply with exactly: WISP_PI_SMOKE_OK",
    });
    if (!eventTypes.includes("assistant_message_completed")) {
      throw new Error("Pi smoke did not emit a completed assistant message.");
    }
    console.log(`Pi live smoke passed for ${providerId}/${modelId}.`);
  } finally {
    await agent?.dispose();
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live Pi smoke.`);
  return value;
}
