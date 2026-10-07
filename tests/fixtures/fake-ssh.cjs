#!/usr/bin/env node
// Stands in for OpenSSH in tests. `-L 127.0.0.1:L:127.0.0.1:R` forwards a real
// local port to R; a trailing remote command answers `wispctl pair` through the
// server's admin socket. FAKE_SSH_FAIL makes it fail like OpenSSH does, and
// FAKE_SSH_REMOTE=missing makes the remote shell lack wispctl, and
// FAKE_SSH_INSTALL=no-node|not-published|systemd makes the server setup fail,
// and FAKE_SSH_INSTALL=hang keeps it running until ssh is stopped.
// `-G alias` prints settings like OpenSSH does: the alias "port-2222" gets
// that port, and "unresolvable" makes it fail.
// With FAKE_SSH_STATE (a directory holding known_hosts and authorized_keys),
// FAKE_SSH_HOSTKEY=unknown refuses hosts not in known_hosts unless SSH_ASKPASS
// trusts them, and FAKE_SSH_PASSWORD refuses keys not in authorized_keys
// unless SSH_ASKPASS answers that password. `-M -S path` is a control master
// that asks those questions once; `-S path` reuses it and `-O check|exit`
// controls it. FAKE_SSH_SERVER_VERSION is the server version a probe finds.
// FAKE_SSH_TAILSCALE=check makes a master wait for an "approved" file in the
// state directory, as Tailscale SSH waits for a browser approval.
// FAKE_SSH_LINGER=sudo|nosudo makes turning on linger need sudo, whose
// password is FAKE_SSH_SUDO_PASSWORD, or find no sudo; FAKE_SSH_INSTALL=no-linger
// makes the setup report that linger is off.
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "-G") {
  const alias = args[args.length - 1];
  if (alias === "unresolvable") process.exit(255);
  process.stdout.write(
    `host ${alias}\nhostname ${alias}.test.invalid\nuser tester\nport ${alias === "port-2222" ? 2222 : 22}\n`,
  );
  process.exit(0);
}
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
const host = args[separator + 1];
const command = args.slice(separator + 2).join(" ");
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const control = option("-S");
const state = process.env.FAKE_SSH_STATE;
const stateFile = (name) => path.join(state, name);
const lines = (name) => (fs.existsSync(stateFile(name)) ? fs.readFileSync(stateFile(name), "utf8").split("\n") : []);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(255);
};

if (option("-O")) {
  // The control master's socket stands in as a plain file.
  if (!fs.existsSync(control)) fail(`Control socket connect(${control}): No such file or directory`);
  if (option("-O") === "exit") fs.rmSync(control);
  process.exit(0);
}
if (control && !args.includes("-M") && !fs.existsSync(control)) {
  fail(`Control socket connect(${control}): No such file or directory`);
}
const interactive = args.includes("BatchMode=no") && process.env.SSH_ASKPASS;
const ask = (prompt) => {
  try {
    return execFileSync(process.env.SSH_ASKPASS, [prompt], { encoding: "utf8" }).replace(/\n$/, "");
  } catch {
    return undefined;
  }
};
// A connection through a master signs in no more.
if (state && !(control && !args.includes("-M"))) {
  if (process.env.FAKE_SSH_HOSTKEY === "unknown" && !lines("known_hosts").includes(host)) {
    const prompt = `The authenticity of host '${host} (100.64.0.9)' can't be established.\nED25519 key fingerprint is SHA256:fakeFingerprint0123456789.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `;
    if (!interactive || ask(prompt) !== "yes") fail("Host key verification failed.");
    fs.appendFileSync(stateFile("known_hosts"), `${host}\n`);
  }
  if (process.env.FAKE_SSH_PASSWORD) {
    const identity = option("-i");
    const blob =
      identity && fs.existsSync(`${identity}.pub`) && fs.readFileSync(`${identity}.pub`, "utf8").split(" ")[1];
    const authorized = blob && lines("authorized_keys").some((line) => line.includes(blob));
    if (!authorized && (!interactive || ask(`tester@${host}'s password: `) !== process.env.FAKE_SSH_PASSWORD)) {
      fail(`tester@${host}: Permission denied (publickey,password).`);
    }
  }
}
if (args.includes("-M")) {
  if (process.env.FAKE_SSH_TAILSCALE === "check" && !fs.existsSync(stateFile("approved"))) {
    process.stderr.write(
      "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/fake123\n",
    );
    while (!fs.existsSync(stateFile("approved"))) execFileSync("sleep", ["0.05"]);
  }
  fs.writeFileSync(control, "");
  // Runs until `-O exit` removes the socket, or ssh is stopped.
  setInterval(() => {
    if (!fs.existsSync(control)) process.exit(0);
  }, 50);
  process.on("SIGTERM", () => process.exit(0));
} else if (command.includes("sudo -S")) {
  let password = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (password += chunk));
  process.stdin.on("end", () => {
    if (password.split("\n")[0] !== process.env.FAKE_SSH_SUDO_PASSWORD) {
      process.stderr.write("Sorry, try again.\nsudo: 1 incorrect password attempt\n");
      process.exit(1);
    }
    fs.writeFileSync(stateFile("linger"), "");
    process.exit(0);
  });
} else if (command === "sh -s") {
  if (process.env.FAKE_SSH_SCRIPT_LOG) fs.writeFileSync(process.env.FAKE_SSH_SCRIPT_LOG, "");
  let script = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    script += chunk;
    if (process.env.FAKE_SSH_SCRIPT_LOG) fs.appendFileSync(process.env.FAKE_SSH_SCRIPT_LOG, chunk);
    // The setup script keeps stdin open after it, to learn about a cancel.
    if (script.includes("setup --json") && script.endsWith("\n")) run(script);
  });
  process.stdin.on("end", () => run(script) || process.exit(0));
} else if (!run(command)) {
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
}

// A command, or a script that `sh -s` reads from stdin.
function run(command) {
  if (command === "true") {
    process.exit(0);
  } else if (command.includes("wisp-server none")) {
    process.stdout.write(`wisp-server ${process.env.FAKE_SSH_SERVER_VERSION || "none"}\n`);
    process.exit(0);
  } else if (command.includes("authorized_keys")) {
    const line = /printf '%s\\n' '([^']+)'/.exec(command)[1];
    fs.appendFileSync(stateFile("authorized_keys"), `${line}\n`);
    process.exit(0);
  } else if (command.includes("loginctl show-user")) {
    const linger = process.env.FAKE_SSH_LINGER;
    process.exit(fs.existsSync(stateFile("linger")) || !linger ? 0 : linger === "nosudo" ? 4 : 3);
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
    const warnings =
      process.env.FAKE_SSH_INSTALL === "no-linger"
        ? ["Wisps stop when you log out. Run `sudo loginctl enable-linger tester` to keep the server running."]
        : [];
    process.stdout.write(`${JSON.stringify({ version: "1.0.0", service: "started", warnings })}\n`);
    process.exit(0);
  } else {
    return false;
  }
  return true;
}
