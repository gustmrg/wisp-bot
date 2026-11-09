import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readPdf } from "../backend/pdf-reader.js";
import { buildPdf } from "./sample-pdf.js";

export interface RuntimeCheck {
  name: "sqlite" | "pdf";
  ok: boolean;
  error?: string;
}

/**
 * Runs what fails first when a build does not fit the machine: SQLite, which
 * is part of Node.js, and reading a scanned PDF page, which loads pdf.js and
 * the native canvas module for this CPU and C library. An archive that
 * reaches the end of these checks can start the server here.
 */
export async function checkRuntime(): Promise<RuntimeCheck[]> {
  return [await check("sqlite", checkSqlite), await check("pdf", checkPdf)];
}

async function check(name: RuntimeCheck["name"], run: () => Promise<void> | void): Promise<RuntimeCheck> {
  try {
    await run();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function checkSqlite(): void {
  const database = new DatabaseSync(":memory:");
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as { version?: unknown } | undefined;
    if (typeof row?.version !== "string") throw new Error("SQLite did not answer.");
  } finally {
    database.close();
  }
}

async function checkPdf(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-runtime-check-"));
  try {
    const file = path.join(directory, "scan.pdf");
    await writeFile(file, buildPdf([{ scan: true }]));
    // A page without text is rendered to an image, which needs the canvas module.
    const result = await readPdf(file, { supportsImages: true });
    if (!result.content.some((block) => block.type === "image")) throw new Error("The page was not rendered.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
