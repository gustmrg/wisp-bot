import { createHash } from "node:crypto";

/** Port the egress proxy listens on inside its container. */
export const EGRESS_PROXY_PORT = 3128;
/** The name Wisp containers reach the proxy by on their network. */
export const EGRESS_PROXY_HOST = "wisp-egress";

/**
 * The egress proxy, run with Node in the sandbox image. Wisp containers whose
 * local network is blocked sit on a network with no route out; this proxy is
 * their only way to the internet. It resolves each destination itself and
 * refuses private, loopback, link-local, multicast and other non-public
 * addresses, then connects to the address it checked, so a name cannot
 * resolve to a public address for the check and a private one for the
 * connection. It handles CONNECT (HTTPS, and anything tunnelled) and plain
 * HTTP requests, and logs nothing about them.
 *
 * `WISP_EGRESS_ALLOW` lists extra CIDR ranges to allow; only tests set it.
 */
export const EGRESS_PROXY_SCRIPT = String.raw`"use strict";
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns").promises;

const PORT = Number(process.env.WISP_EGRESS_PORT || 3128);
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

server.listen(PORT, () => console.log("listening " + server.address().port));
`;

export const EGRESS_PROXY_SCRIPT_HASH = createHash("sha256").update(EGRESS_PROXY_SCRIPT).digest("hex").slice(0, 12);
