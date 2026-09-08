import { createServer, request as httpRequest, type Server } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { boundedString, HttpError } from "./errors.js";
import type { DeviceAuth } from "./auth/device-auth.js";
import { jsonBody } from "./http/security.js";

export type AdminOperation = (command: Record<string, unknown>) => Promise<unknown>;
export async function startAdminSocket(
  directory: string,
  auth: DeviceAuth,
  operation?: AdminOperation,
): Promise<Server> {
  const socket = path.join(directory, "admin.sock");
  try {
    const info = await lstat(socket);
    if (!info.isSocket()) throw new Error("The admin socket path is occupied by a non-socket file.");
    await unlink(socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Node has no portable SO_PEERCRED API. The owner-only parent directory and 0600
  // socket enforce the OS-user boundary (root is inherently an administrator).
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/admin")
        throw new HttpError(404, "not_found", "Unknown administrative operation.");
      const body = await jsonBody(request, 16 * 1024);
      const command = boundedString(body.command);
      let result: unknown;
      if (command === "pair") result = auth.createPairingCode();
      else if (command === "devices") result = auth.devices();
      else if (command === "revoke") {
        auth.revoke(boundedString(body.deviceId));
        result = {};
      } else if (operation) result = await operation(body);
      else throw new HttpError(400, "invalid_request", "Unknown administrative operation.");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, value: result }));
    } catch (error) {
      response.writeHead(error instanceof HttpError ? error.status : 500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error: {
            code: error instanceof HttpError ? error.code : "internal_error",
            message: error instanceof HttpError ? error.message : "The administrative operation failed.",
            retryable: false,
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  await chmod(socket, 0o600);
  return server;
}
export function adminRequest(directory: string, command: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: path.join(directory, "admin.sock"),
        path: "/admin",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 60_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 8 * 1024 * 1024) {
            req.destroy();
            reject(new Error("The admin response exceeds the limit."));
          }
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(text);
            if (value.ok) resolve(value.value);
            else reject(new Error(value.error?.message ?? "Administrative operation failed."));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("The administrative operation timed out.")));
    req.end(JSON.stringify(command));
  });
}
