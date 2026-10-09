#!/usr/bin/env node
// Stands in for OpenSSH in tests. `-L 127.0.0.1:L:127.0.0.1:R` forwards a real
// local port to R; a trailing remote command answers `wispctl pair` through the
// server's admin socket. FAKE_SSH_FAIL makes it fail like OpenSSH does, and
// FAKE_SSH_REMOTE=missing makes the remote shell lack wispctl, and
// FAKE_SSH_INSTALL=no-node|not-published|systemd makes the server setup fail,
// and FAKE_SSH_INSTALL=hang keeps it running until ssh is stopped.
// FAKE_SSH_ASK=hostkey|password|passphrase asks through SSH_ASKPASS like
// OpenSSH does: the host key is trusted once in FAKE_SSH_KNOWN, the password
// is "hunter2" until a key is added to FAKE_SSH_AUTHORIZED, and the
// passphrase is "open sesame". Without SSH_ASKPASS, it fails like BatchMode.
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
const failures = {
  hostkey: "Host key verification failed.",
  changed:
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.",
  denied: "user@host: Permission denied (publickey).",
  "denied-password": "gustavo@home-server: Permission denied (publickey,password).",
  resolve: "ssh: Could not resolve hostname nowhere: Name or service not known",
  refused: "ssh: connect to host home-server port 2222: Connection refused",
};
if (args[0] === "-G") {
  // What OpenSSH would use for the host; FAKE_SSH_IDENTITY names the key file.
  process.stdout.write(`user wisp\nidentityfile ${process.env.FAKE_SSH_IDENTITY || "~/.ssh/id_ed25519"}\n`);
  process.exit(0);
}
if (failures[process.env.FAKE_SSH_FAIL]) {
  process.stderr.write(`${failures[process.env.FAKE_SSH_FAIL]}\n`);
  process.exit(255);
}

/** Asks like OpenSSH: through SSH_ASKPASS when it is forced, never otherwise. */
function ask(prompt) {
  if (process.env.SSH_ASKPASS_REQUIRE !== "force" || !process.env.SSH_ASKPASS) return undefined;
  try {
    return execFileSync(process.env.SSH_ASKPASS, [prompt], { encoding: "utf8" }).replace(/\n$/, "");
  } catch {
    return undefined;
  }
}
function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
const asks = new Set((process.env.FAKE_SSH_ASK || "").split(",").filter(Boolean));
if (asks.has("hostkey") && !read(process.env.FAKE_SSH_KNOWN).includes("home-server")) {
  const answer = ask(
    "The authenticity of host 'home-server (127.0.0.1)' can't be established.\nED25519 key fingerprint is SHA256:fakefakefake.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
  );
  if (answer !== "yes") {
    process.stderr.write("Host key verification failed.\n");
    process.exit(255);
  }
  fs.appendFileSync(process.env.FAKE_SSH_KNOWN, "home-server ssh-ed25519 AAAA\n");
}
if (asks.has("passphrase") && ask("Enter passphrase for key '/home/wisp/.ssh/id_ed25519': ") !== "open sesame") {
  process.stderr.write("wisp@home-server: Permission denied (publickey).\n");
  process.exit(255);
}
if (asks.has("password") && !read(process.env.FAKE_SSH_AUTHORIZED).trim()) {
  let accepted = false;
  for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
    accepted = ask("wisp@home-server's password: ") === "hunter2";
  }
  if (!accepted) {
    process.stderr.write("wisp@home-server: Permission denied (publickey,password).\n");
    process.exit(255);
  }
}
const separator = args.indexOf("--");
const command = args.slice(separator + 2).join(" ");
if (command.includes("authorized_keys")) {
  // Adding keys: they arrive on stdin.
  let keys = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (keys += chunk));
  process.stdin.on("end", () => {
    fs.appendFileSync(process.env.FAKE_SSH_AUTHORIZED, keys);
    process.exit(0);
  });
} else if (command.includes("setup --json") && process.env.FAKE_SSH_INSTALL === "hang") {
  process.stderr.write("Installing @gustmrg/wisp-server@1.0.0…\n");
  // Runs until the test stops ssh.
  setInterval(() => undefined, 60_000);
} else if (command.includes("setup --json")) {
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
} else if (command) {
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
