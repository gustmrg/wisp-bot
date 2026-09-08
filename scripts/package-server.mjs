import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("release/server");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp("dist-server", output, { recursive: true });
await cp("dist-web", path.join(output, "web"), { recursive: true });
for (const file of ["package.json", "package-lock.json"]) await cp(`server/${file}`, path.join(output, file));
// Package templates explicitly: deploy/docker may also hold a live master.key.
for (const file of [
  "wispctl",
  "systemd/wisp.service",
  "systemd/server.env.example",
  "docker/Dockerfile",
  "docker/compose.yaml",
  "tailscale/policy.hujson",
]) {
  await mkdir(path.dirname(path.join(output, "deploy", file)), { recursive: true });
  await cp(path.join("deploy", file), path.join(output, "deploy", file));
}
console.log(
  "Server package prepared at release/server; install production dependencies on the target architecture with npm ci --omit=dev.",
);
