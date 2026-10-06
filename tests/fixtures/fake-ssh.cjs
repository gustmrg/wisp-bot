#!/usr/bin/env node
// Stands in for OpenSSH in tests. `-L 127.0.0.1:L:127.0.0.1:R` forwards a real
// local port to R; a trailing remote command answers `wispctl pair` through the
// server's admin socket. FAKE_SSH_FAIL makes it fail like OpenSSH does.
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
const failures = {
  hostkey: "Host key verification failed.",
  denied: "user@host: Permission denied (publickey).",
  resolve: "ssh: Could not resolve hostname nowhere: Name or service not known",
};
if (failures[process.env.FAKE_SSH_FAIL]) {
  process.stderr.write(`${failures[process.env.FAKE_SSH_FAIL]}\n`);
  process.exit(255);
}
const separator = args.indexOf("--");
const command = args.slice(separator + 2).join(" ");
if (command) {
  if (!command.includes("wispctl pair --json")) process.exit(127);
  const request = http.request(
    { socketPath: path.join(process.env.FAKE_WISP_DATA_DIR, "admin.sock"), path: "/admin", method: "POST" },
    (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => {
        process.stdout.write(`${JSON.stringify(JSON.parse(text).value)}\n`);
        process.exit(0);
      });
    },
  );
  request.on("error", () => {
    process.stderr.write("wispctl: No Wisp server is running.\n");
    process.exit(1);
  });
  request.end(JSON.stringify({ command: "pair" }));
} else {
  const spec = args[args.indexOf("-L") + 1].split(":");
  const server = net.createServer((socket) => {
    const upstream = net.connect(Number(spec[3]), "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.listen(Number(spec[1]), spec[0]);
  process.on("SIGTERM", () => process.exit(0));
}
