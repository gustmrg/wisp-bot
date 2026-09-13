import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import type { LogSink } from "./structured-logger.js";

export interface FileLogSinkOptions {
  /** Maximum size of the active log file before it rotates to `<name>.1`. */
  maxFileBytes?: number;
  /** Overrides the injected filesystem for tests. */
  fs?: FileLogFs;
}

export interface FileLogFs {
  appendFile(filePath: string, data: string): Promise<void>;
  mkdir(directory: string, options: { recursive: true }): Promise<string | undefined>;
  rename(from: string, to: string): Promise<void>;
  stat(filePath: string): Promise<{ size: number } | undefined>;
}

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export class FileLogSink implements LogSink {
  private readonly fs: FileLogFs;
  private readonly directory: string;
  private readonly filePath: string;
  private readonly rotatedPath: string;
  private readonly maxFileBytes: number;
  private directoryReady: Promise<void> | undefined;
  private currentSize: number | null = null;

  constructor(directory: string, options: FileLogSinkOptions = {}) {
    this.fs = options.fs ?? nodeFs;
    this.directory = directory;
    this.filePath = path.join(directory, "backend.log");
    this.rotatedPath = path.join(directory, "backend.log.1");
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  info(value: string): void {
    void this.write(value);
  }

  warn(value: string): void {
    void this.write(value);
  }

  private async write(value: string): Promise<void> {
    try {
      this.directoryReady ??= this.fs.mkdir(this.directory, { recursive: true }).then(() => undefined);
      await this.directoryReady;
      const line = `${value}\n`;
      const size = this.currentSize ?? (await this.measureCurrentSize());
      if (size + Buffer.byteLength(line) > this.maxFileBytes) {
        await this.fs.rename(this.filePath, this.rotatedPath).catch(() => undefined);
        this.currentSize = 0;
      }
      await this.fs.appendFile(this.filePath, line);
      this.currentSize = (this.currentSize ?? size) + Buffer.byteLength(line);
    } catch {
      // Logging must never take the app down; the line is dropped.
    }
  }

  private async measureCurrentSize(): Promise<number> {
    const info = await this.fs.stat(this.filePath).catch(() => undefined);
    this.currentSize = info?.size ?? 0;
    return this.currentSize;
  }
}

const nodeFs: FileLogFs = {
  appendFile: (filePath, data) => appendFile(filePath, data),
  mkdir: (directory, options) => mkdir(directory, options),
  rename: (from, to) => rename(from, to),
  stat: async (filePath) => {
    try {
      return await stat(filePath);
    } catch {
      return undefined;
    }
  },
};
