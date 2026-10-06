import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import path from "node:path";

import { boundedString, HttpError } from "./errors.js";
import { readJsonBody, sendError, sendJson } from "./http-util.js";

export const ADMIN_SOCKET_NAME = "admin.sock";

export type AdminCommand = Record<string, unknown> & { command: string };
export type AdminHandler = (command: AdminCommand) => Promise<unknown> | unknown;

/**
 * Serves administrative commands on a Unix socket readable only by the
 * account that owns the data directory. Reaching the socket is the
 * authorization: whoever can, already owns every file the server reads.
 */
export async function startAdminSocket(dataDirectory: string, handle: AdminHandler): Promise<Server> {
  const socketPath = path.join(dataDirectory, ADMIN_SOCKET_NAME);
  try {
    if (!(await lstat(socketPath)).isSocket()) throw new Error("The admin socket path is taken by another file.");
    // A socket left behind by a crash; the instance lock guarantees no live server owns it.
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/admin") {
        throw new HttpError(404, "not_found", "Unknown administrative request.");
      }
      const body = await readJsonBody(request, 16 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new HttpError(400, "invalid_request", "Invalid command.");
      const command = {
        ...(body as Record<string, unknown>),
        command: boundedString((body as Record<string, unknown>).command, 64),
      };
      sendJson(response, 200, { ok: true, value: (await handle(command)) ?? {} });
    })().catch((error: unknown) => {
      sendError(
        response,
        error instanceof HttpError ? error : new HttpError(500, "internal_error", "The administrative command failed."),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return server;
}

/** Sends one command to a running server's admin socket and resolves with its value. */
export function adminRequest(dataDirectory: string, command: AdminCommand): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: path.join(dataDirectory, ADMIN_SOCKET_NAME),
        path: "/admin",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 30_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          try {
            const body = JSON.parse(text) as { ok: boolean; value?: unknown; error?: { message?: string } };
            if (body.ok) resolve(body.value);
            else reject(new Error(body.error?.message ?? "The administrative command failed."));
          } catch {
            reject(new Error("The server sent an invalid administrative response."));
          }
        });
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error(`No Wisp server is running for ${dataDirectory}. Start it, or set WISP_DATA_DIR.`)
          : error,
      ),
    );
    request.on("timeout", () => request.destroy(new Error("The administrative command timed out.")));
    request.end(JSON.stringify(command));
  });
}
