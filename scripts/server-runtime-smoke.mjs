import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";

const install = path.resolve(process.argv[2] ?? "release/server");
const resolveFromRuntime = createRequire(path.join(install, "package.json"));
const directory = await mkdtemp(path.join(tmpdir(), "wisp-runtime-"));
let child;
try {
  // Verify the runtime package manifest, rather than ancestor node_modules discovery.
  const manifest = resolveFromRuntime("./package.json");
  if (Object.keys(manifest.dependencies).some((name) => /electron|capacitor|react/.test(name)))
    throw new Error("Desktop dependency in headless runtime");
  const { ModelService } = resolveFromRuntime("./backend/model-service.js");
  const { MasterKeyEncryption } = resolveFromRuntime("./server/encryption/master-key.js");
  const models = await ModelService.create({
    dataDirectory: directory,
    encryption: new MasterKeyEncryption(randomBytes(32)),
  });
  const runtime = models.getModelRuntime();
  const provider = runtime.getProviders().find((value) => value.auth.apiKey && runtime.getModels(value.id).length);
  if (!provider) throw new Error("Pi runtime has no offline provider catalog");
  await runtime.setRuntimeApiKey(provider.id, "test-only-never-sent");
  const { SdkPiSessionFactory } = resolveFromRuntime("./backend/pi-conversation-agent.js");
  const context = {
    conversationId: "smoke",
    sessionId: "smoke",
    name: "Smoke",
    label: "Test",
    description: "Offline runtime test",
    workspaceDirectory: path.join(directory, "workspace"),
    sessionDirectory: path.join(directory, "sessions"),
    configDirectory: path.join(directory, "config"),
    piSessionId: null,
    piSessionFile: null,
    savePiSessionIdentity: async () => {},
  };
  await Promise.all(
    [context.workspaceDirectory, context.sessionDirectory, context.configDirectory].map((value) =>
      mkdir(value, { recursive: true }),
    ),
  );
  const factory = new SdkPiSessionFactory(runtime);
  const selection = { providerId: provider.id, modelId: runtime.getModels(provider.id)[0].id };
  const initial = await factory.create(context, selection);
  const identity = { piSessionId: initial.sessionId, piSessionFile: initial.sessionFile };
  initial.dispose();
  const resumed = await factory.create({ ...context, ...identity }, selection);
  if (resumed.sessionId !== identity.piSessionId) throw new Error("Pi session did not resume its identity");
  resumed.dispose();
  const key = path.join(directory, "master.key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  child = spawn(
    process.execPath,
    [
      path.join(install, "server/main.js"),
      "--data-dir",
      path.join(directory, "data"),
      "--key-file",
      key,
      "--agent-mode",
      "fake",
      "--port",
      "18787",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Server readiness timed out")), 15000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`Server exited ${code}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes('"event":"server_ready"')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  await ready;
  const health = await fetch("http://127.0.0.1:18787/health/ready");
  if (!health.ok) throw new Error("Runtime is not ready");
  const unauthorized = await fetch("http://127.0.0.1:18787/api/v1/snapshot");
  if (unauthorized.status !== 401) throw new Error("Runtime allowed anonymous history access");
  const cli = spawn(
    process.execPath,
    [path.join(install, "server/cli.js"), "status", "--data-dir", path.join(directory, "data"), "--json"],
    { stdio: "ignore" },
  );
  const [code] = await once(cli, "exit");
  if (code !== 0) throw new Error("Administrative CLI failed");
  console.log(`Standalone runtime passed on ${process.platform}/${process.arch}`);
} finally {
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    await ended;
  }
  await rm(directory, { recursive: true, force: true });
}
