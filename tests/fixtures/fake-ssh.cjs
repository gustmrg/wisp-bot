#!/usr/bin/env node
// Stands in for OpenSSH in tests. `-L 127.0.0.1:L:127.0.0.1:R` forwards a real
// local port to R; a trailing remote command answers `wispctl pair` through the
// server's admin socket. FAKE_SSH_FAIL makes it fail like OpenSSH does, and
// FAKE_SSH_REMOTE=missing makes the remote shell lack wispctl, and
// FAKE_SSH_INSTALL=no-node|not-published|systemd makes the server setup fail.
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
  refused: "ssh: connect to host home-server port 2222: Connection refused",
};
if (failures[process.env.FAKE_SSH_FAIL]) {
  process.stderr.write(`${failures[process.env.FAKE_SSH_FAIL]}\n`);
  process.exit(255);
}
const separator = args.indexOf("--");
const command = args.slice(separator + 2).join(" ");
if (command.includes("setup --json")) {
  // `npx @gustmrg/wisp-server@VERSION setup`, run on the server.
  const outcomes = {
    "no-node": ["bash: line 1: npx: command not found", 127],
    "not-published": [
      "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@gustmrg%2fwisp-server",
      1,
    ],
    systemd: ["The systemd user session is not running (Failed to connect to bus).", 1],
  };
  const outcome = outcomes[process.env.FAKE_SSH_INSTALL];
  if (outcome) {
    process.stderr.write(`${outcome[0]}\n`);
    process.exit(outcome[1]);
  }
  process.stderr.write("Installing @gustmrg/wisp-server@1.0.0…\nStarting the service…\n");
  process.stdout.write(`${JSON.stringify({ version: "1.0.0", service: "started" })}\n`);
  process.exit(0);
}
if (command) {
  if (!command.includes("wispctl pair --json") || process.env.FAKE_SSH_REMOTE === "missing") {
    process.stderr.write("bash: line 1: wispctl: command not found\n");
    process.exit(127);
  }
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
    // OpenSSH reports a forward the server refused, then drops the local connection.
    upstream.on("error", () => {
      process.stderr.write("channel 2: open failed: connect failed: Connection refused\n");
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
  });
  server.listen(Number(spec[1]), spec[0]);
  process.on("SIGTERM", () => process.exit(0));
}
