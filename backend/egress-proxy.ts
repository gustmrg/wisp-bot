import { createHash } from "node:crypto";

/** Port the egress proxy listens on inside its container. */
export const EGRESS_PROXY_PORT = 3128;
/** Port of the git gateway, in the same proxy container. */
export const EGRESS_GIT_PORT = 3129;
/** The name Wisp containers reach the proxy by on their network. */
export const EGRESS_PROXY_HOST = "wisp-egress";

/**
 * The forges git in a Wisp's container reaches through the git gateway, each
 * with the token the gateway adds. github.com is always reached through it,
 * without a token when none is given, so public repositories still work.
 */
export interface GitForges {
  github?: { token: string };
  /** The GitLab plugin's instance (`https://gitlab.com`, or the user's own, with any path it is served under). */
  gitlab?: { upstream: string; token: string };
}

/**
 * The egress proxy, run with Node in the sandbox image. It serves three
 * things:
 *
 * - **The egress proxy.** Wisp containers whose local network is blocked sit
 *   on a network with no route out; this proxy is their only way to the
 *   internet. It resolves each destination itself and refuses private,
 *   loopback, link-local, multicast and other non-public addresses, then
 *   connects to the address it checked, so a name cannot resolve to a public
 *   address for the check and a private one for the connection. It handles
 *   CONNECT (HTTPS, and anything tunnelled) and plain HTTP requests, and logs
 *   nothing about them.
 * - **The git gateway.** git in every Wisp container sends requests for
 *   its git hosts here over plain HTTP, under the forge's name
 *   (`/github/owner/repo.git/...` for github.com, `/gitlab/group/project.git/...`
 *   for the instance of the Wisp's GitLab plugin). Only git's smart HTTP
 *   protocol (and git LFS's batch and lock check) is carried; the gateway
 *   adds the Wisp's token for that forge and sends the request to the forge
 *   over HTTPS. The token never enters a Wisp's container, and the forge's
 *   API cannot be reached with it. Each Wisp reaches the proxy only over its
 *   own network, so the address a request arrives on tells which Wisp sent it.
 *   A GitLab instance on the local network is reached even by a Wisp whose
 *   local network is blocked: the user chose it, and only git goes there.
 * - **The control socket**, an abstract Unix socket that only processes in
 *   the proxy's own container can reach. The server runs
 *   `node <script> control` in the container with `{ address, forges }` on
 *   stdin to set (or, with null forges, forget) the token for each forge for
 *   requests arriving on that address.
 *
 * `WISP_EGRESS_ALLOW` lists extra CIDR ranges to allow, `WISP_GIT_UPSTREAM`
 * replaces github.com, `WISP_GIT_INSECURE_UPSTREAMS=1` lets the server give
 * plain HTTP instances and `WISP_EGRESS_CONTROL` names the control socket;
 * only tests set them.
 */
export const EGRESS_PROXY_SCRIPT = String.raw`"use strict";
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dns = require("node:dns").promises;

const PORT = Number(process.env.WISP_EGRESS_PORT || 3128);
const GIT_PORT = Number(process.env.WISP_GIT_PORT || 3129);
const GIT_UPSTREAM = new URL(process.env.WISP_GIT_UPSTREAM || "https://github.com");
const CONTROL = "\0" + (process.env.WISP_EGRESS_CONTROL || "wisp-egress-control");
const IDLE_MS = 10 * 60 * 1000;
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");
const allowed = new net.BlockList();
for (const range of (process.env.WISP_EGRESS_ALLOW || "").split(",").filter(Boolean)) {
  const [address, prefix] = range.split("/");
  allowed.addSubnet(address, Number(prefix), net.isIPv6(address) ? "ipv6" : "ipv4");
}

// IPv4-mapped IPv6 addresses (::ffff:10.0.0.1, ::ffff:a00:1) are checked against the IPv4 ranges by
// BlockList itself. A ::ffff:0:0/96 rule must not be added: BlockList would then match every IPv4 address.
function isPublic(address) {
  const family = net.isIPv6(address) ? "ipv6" : "ipv4";
  if (allowed.check(address, family)) return true;
  return !blocked.check(address, family);
}

async function publicAddress(host) {
  const name = host.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(name)
    ? [name]
    : (await dns.lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!addresses.length) throw Object.assign(new Error("not found"), { status: 502 });
  // Every answer must be public, so no answer can be picked to reach the local network.
  if (!addresses.every(isPublic)) throw Object.assign(new Error("blocked"), { status: 403 });
  return addresses[0];
}

const BLOCKED_MESSAGE = "Wisp blocks connections to local and private network addresses.\n";

function refuse(socket, error) {
  const status = error && error.status === 403 ? "403 Forbidden" : "502 Bad Gateway";
  const body = error && error.status === 403 ? BLOCKED_MESSAGE : "The destination could not be reached.\n";
  socket.end("HTTP/1.1 " + status + "\r\nContent-Type: text/plain\r\nContent-Length: " + Buffer.byteLength(body) + "\r\nConnection: close\r\n\r\n" + body);
}

function splitHostPort(value, defaultPort) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value || "");
  if (!match) return null;
  const port = Number(match[2] || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    response.writeHead(400).end("Use this proxy for absolute http:// URLs.\n");
    return;
  }
  if (url.protocol !== "http:") {
    response.writeHead(400).end("Use CONNECT for https:// URLs.\n");
    return;
  }
  let address;
  try {
    address = await publicAddress(url.hostname);
  } catch (error) {
    refuse(response.socket, error);
    return;
  }
  const headers = { ...request.headers, host: url.host };
  for (const name of Object.keys(headers)) if (name.startsWith("proxy-")) delete headers[name];
  const upstream = http.request(
    { host: address, port: Number(url.port || 80), method: request.method, path: url.pathname + url.search, headers, setHost: false },
    (reply) => {
      response.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.setTimeout(IDLE_MS, () => upstream.destroy());
  upstream.on("error", () => (response.headersSent ? response.destroy() : refuse(response.socket)));
  request.pipe(upstream);
});

server.on("connect", async (request, client, head) => {
  client.on("error", () => undefined);
  const target = splitHostPort(request.url, 443);
  if (!target) return refuse(client);
  let address;
  try {
    address = await publicAddress(target.host);
  } catch (error) {
    return refuse(client, error);
  }
  let connected = false;
  const upstream = net.connect(target.port, address, () => {
    connected = true;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.setTimeout(IDLE_MS, () => upstream.destroy());
  client.setTimeout(IDLE_MS, () => client.destroy());
  upstream.on("error", () => (connected ? client.destroy() : refuse(client)));
  client.on("close", () => upstream.destroy());
});

/**
 * The forges the git gateway carries, by the first segment of a request's
 * path: where requests go, which repository paths it accepts, and the user
 * name its token is sent with. A forge without an upstream of its own goes
 * where the server said for the Wisp, and is refused for a Wisp it said
 * nothing about.
 */
const FORGES = {
  github: {
    upstream: GIT_UPSTREAM,
    repository: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
    user: "x-access-token",
  },
  // A project under up to 20 levels of groups; GitLab's own routes have a "-" segment, which is refused.
  gitlab: {
    upstream: null,
    repository: /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}(\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}){1,20}$/,
    user: "oauth2",
  },
};
/** Per forge, the token for requests arriving on each of the proxy's addresses, one per Wisp network. */
const gitForges = new Map();
const GIT_PATH = /^\/([a-z]+)\/(.+)\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks\/verify)$/;
const GIT_TOKEN = /^[\x21-\x7e]{1,512}$/;
const GIT_REQUEST_HEADERS = ["accept", "accept-encoding", "content-encoding", "content-length", "content-type", "git-protocol", "user-agent"];
const HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding"];
const GIT_REFUSED = "The Wisp git gateway carries only git over HTTPS to the git hosts of this Wisp's plugins. Use the plugins' tools for anything else.\n";

function unmapped(address) {
  return address && address.startsWith("::ffff:") ? address.slice(7) : address || "";
}

function forge(id) {
  return Object.prototype.hasOwnProperty.call(FORGES, id) ? FORGES[id] : null;
}

/**
 * Where a request goes, when it is part of git's smart HTTP protocol, or git
 * LFS's batch and lock check, for one repository of a forge; null otherwise.
 */
function gitTarget(address, method, url) {
  const match = GIT_PATH.exec(url.pathname);
  const target = match && forge(match[1]);
  if (!target || !target.repository.test(match[2])) return null;
  if (match[2].split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (match[3] === "info/refs") {
    if (method !== "GET" || !/^\?service=git-(upload|receive)-pack$/.test(url.search)) return null;
  } else if (method !== "POST" || url.search !== "") return null;
  const given = (gitForges.get(address) || {})[match[1]];
  const upstream = target.upstream || (given && given.upstream);
  if (!upstream) return null;
  return { id: match[1], forge: target, upstream, token: given && given.token, path: "/" + match[2] + "/" + match[3] };
}

const gitServer = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url, "http://gateway");
  } catch {
    url = null;
  }
  const target = url && request.url.startsWith("/") && !request.url.startsWith("//")
    ? gitTarget(unmapped(request.socket.localAddress), request.method, url)
    : null;
  if (!target) {
    request.resume();
    response.writeHead(403, { "content-type": "text/plain" }).end(GIT_REFUSED);
    return;
  }
  const headers = {};
  for (const name of GIT_REQUEST_HEADERS) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
  if (target.token) headers.authorization = "Basic " + Buffer.from(target.forge.user + ":" + target.token).toString("base64");
  const base = target.upstream.pathname.replace(/\/$/, "");
  const upstream = (target.upstream.protocol === "https:" ? https : http).request(
    {
      protocol: target.upstream.protocol,
      hostname: target.upstream.hostname,
      port: target.upstream.port || undefined,
      method: request.method,
      path: base + target.path + url.search,
      headers,
    },
    (reply) => {
      const replyHeaders = { ...reply.headers };
      for (const name of HOP_HEADERS) delete replyHeaders[name];
      // A moved repository redirects to the forge; keep git on the gateway, or it would lose the token.
      const host = request.headers.host;
      const location = replyHeaders.location;
      const from = target.upstream.origin + base + "/";
      if (typeof location === "string" && location.startsWith(from) && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host || "")) {
        replyHeaders.location = "http://" + host + "/" + target.id + "/" + location.slice(from.length);
      }
      response.writeHead(reply.statusCode || 502, replyHeaders);
      reply.pipe(response);
    },
  );
  upstream.setTimeout(IDLE_MS, () => upstream.destroy());
  upstream.on("error", () => {
    if (response.headersSent) return response.destroy();
    response.writeHead(502, { "content-type": "text/plain" }).end(target.upstream.host + " could not be reached.\n");
  });
  request.pipe(upstream);
});

/** An instance's address from the server: HTTPS, with no credentials, query or fragment. */
function parseUpstream(value) {
  const url = typeof value === "string" && value.length <= 2048 ? new URL(value) : null;
  const insecure = process.env.WISP_GIT_INSECURE_UPSTREAMS === "1" && url && url.protocol === "http:";
  if (!url || (url.protocol !== "https:" && !insecure) || url.username || url.password || url.search || url.hash) {
    throw new Error("upstream");
  }
  return url;
}

/** The forges a control message gives for an address, checked; throws on anything else. */
function parseForges(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("forges");
  const forges = {};
  for (const [id, entry] of Object.entries(value)) {
    const target = forge(id);
    if (!target || !entry || typeof entry.token !== "string" || !GIT_TOKEN.test(entry.token)) throw new Error("forge");
    // Only a forge without an upstream of its own is told where to go.
    const keys = target.upstream ? ["token"] : ["token", "upstream"];
    if (Object.keys(entry).some((key) => !keys.includes(key))) throw new Error("forge");
    forges[id] = target.upstream ? { token: entry.token } : { token: entry.token, upstream: parseUpstream(entry.upstream) };
  }
  return forges;
}

const control = net.createServer({ allowHalfOpen: true }, (socket) => {
  let input = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    input += chunk;
    if (input.length > 4096) socket.destroy();
  });
  socket.on("end", () => {
    try {
      const { address, forges } = JSON.parse(input);
      if (typeof address !== "string" || !net.isIP(address)) throw new Error("address");
      if (forges === null) gitForges.delete(address);
      else gitForges.set(address, parseForges(forges));
      socket.end("ok\n");
    } catch {
      socket.end("invalid\n");
    }
  });
});

if ((process.argv || [])[2] === "control") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    let reply = "";
    const socket = net.connect(CONTROL, () => socket.end(input));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("error", () => process.exit(1));
    socket.on("close", () => process.exit(reply === "ok\n" ? 0 : 1));
  });
} else {
  let pending = 3;
  const ready = () => {
    if (--pending === 0) console.log("listening " + server.address().port + " git " + gitServer.address().port);
  };
  control.listen(CONTROL, ready);
  gitServer.listen(GIT_PORT, ready);
  server.listen(PORT, ready);
}
`;

export const EGRESS_PROXY_SCRIPT_HASH = createHash("sha256").update(EGRESS_PROXY_SCRIPT).digest("hex").slice(0, 12);
