import { describe, expect, it, vi } from "vitest";

import { FileLogSink } from "../electron/backend/file-log-sink.js";
import type { FileLogFs } from "../electron/backend/file-log-sink.js";

function fsStub() {
  const files = new Map<string, string>();
  const fs: FileLogFs = {
    appendFile: async (filePath, data) => {
      files.set(filePath, (files.get(filePath) ?? "") + data);
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      const contents = files.get(from);
      if (contents === undefined) throw new Error("missing file");
      files.delete(from);
      files.set(to, contents);
    },
    stat: async (filePath) => {
      const contents = files.get(filePath);
      return contents === undefined ? undefined : { size: contents.length };
    },
  };
  return { files, fs };
}

describe("FileLogSink", () => {
  it("appends lines to the log file inside the given directory", async () => {
    const { files, fs } = fsStub();
    const sink = new FileLogSink("/data/logs", { fs });

    sink.info("first");
    sink.warn("second");
    await vi.waitFor(() => {
      expect(files.get("/data/logs/backend.log")).toBe("first\nsecond\n");
    });
  });

  it("rotates the active log once it would exceed the size cap", async () => {
    const { files, fs } = fsStub();
    const sink = new FileLogSink("/data/logs", { fs, maxFileBytes: 8 });

    sink.info("aaaa");
    await vi.waitFor(() => {
      expect(files.get("/data/logs/backend.log")).toBe("aaaa\n");
    });
    sink.info("bbbb");
    await vi.waitFor(() => {
      expect(files.get("/data/logs/backend.log")).toBe("bbbb\n");
      expect(files.get("/data/logs/backend.log.1")).toBe("aaaa\n");
    });
  });

  it("drops lines instead of throwing when the filesystem fails", async () => {
    const fs: FileLogFs = {
      appendFile: async () => {
        throw new Error("disk full");
      },
      mkdir: async () => {
        throw new Error("permission denied");
      },
      rename: async () => undefined,
      stat: async () => undefined,
    };
    const sink = new FileLogSink("/data/logs", { fs });

    expect(() => sink.warn("boom")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("accounts for existing file content written by a previous run", async () => {
    const { files, fs } = fsStub();
    files.set("/data/logs/backend.log", "12345678");
    const sink = new FileLogSink("/data/logs", { fs, maxFileBytes: 10 });

    sink.info("abc");
    await vi.waitFor(() => {
      expect(files.get("/data/logs/backend.log.1")).toBe("12345678");
      expect(files.get("/data/logs/backend.log")).toBe("abc\n");
    });
  });
});
