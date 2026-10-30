import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  MEMORY_LIMITS,
  MemoryError,
  MemoryNewerSchemaError,
  MemoryStore,
  type MemoryErrorDetails,
  type MemoryWriteContext,
} from "../backend/memory/index.js";

const owner: MemoryWriteContext = { wispId: "lumi", source: "owner" };
const agent: MemoryWriteContext = { wispId: "lumi", source: "agent" };

function open(now = () => new Date("2026-10-23T12:00:00.000Z")) {
  const db = new DatabaseSync(":memory:");
  return { db, store: MemoryStore.open(db, { now }) };
}

function failure(write: () => unknown): MemoryErrorDetails {
  try {
    write();
  } catch (error) {
    if (error instanceof MemoryError) return error.details;
    throw error;
  }
  throw new Error("Expected a MemoryError.");
}

describe("MemoryStore", () => {
  it("adds entries with short, increasing IDs in their scope", () => {
    const { store } = open();
    const added = store.apply(
      [
        { op: "add", scope: "user", text: "  Prefers short answers.  " },
        { op: "add", scope: "wisp", text: "Main project is Wisp Bot." },
      ],
      agent,
    );
    expect(
      added.map(({ id, scope, wispId, text, source, status }) => ({ id, scope, wispId, text, source, status })),
    ).toEqual([
      { id: "m1", scope: "user", wispId: null, text: "Prefers short answers.", source: "agent", status: "active" },
      { id: "m2", scope: "wisp", wispId: "lumi", text: "Main project is Wisp Bot.", source: "agent", status: "active" },
    ]);
  });

  it("shares user entries with every Wisp and keeps wisp entries to their own", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "user", text: "Lives in Brazil." }], owner);
    store.apply([{ op: "add", scope: "wisp", text: "Lumi fact." }], owner);
    store.apply([{ op: "add", scope: "wisp", text: "Echo fact." }], { wispId: "echo", source: "owner" });

    expect(store.active("lumi").map((entry) => entry.text)).toEqual(["Lives in Brazil.", "Lumi fact."]);
    expect(store.active("echo").map((entry) => entry.text)).toEqual(["Lives in Brazil.", "Echo fact."]);
    expect(failure(() => store.apply([{ op: "remove", id: "m3" }], owner)).code).toBe("not_found");
  });

  it("gives the person outside any Wisp their own entries and nothing of a Wisp's", () => {
    const { store } = open();
    const person: MemoryWriteContext = { wispId: null, source: "owner" };
    store.apply([{ op: "add", scope: "wisp", text: "Lumi fact." }], owner);
    store.apply([{ op: "add", scope: "user", text: "Lives in Brazil." }], person);

    expect(store.list(null).map(({ id, text }) => [id, text])).toEqual([["m2", "Lives in Brazil."]]);
    expect(store.active("lumi").map((entry) => entry.text)).toEqual(["Lives in Brazil.", "Lumi fact."]);
    expect(store.usage(null)).toEqual([{ scope: "user", used: 16, limit: MEMORY_LIMITS.user }]);
    expect(failure(() => store.apply([{ op: "remove", id: "m1" }], person)).code).toBe("not_found");
    expect(failure(() => store.apply([{ op: "add", scope: "wisp", text: "Orphan." }], person)).code).toBe(
      "invalid_state",
    );
    store.apply([{ op: "patch", id: "m2", text: "Lives in Portugal." }], person);
    expect(store.active("lumi").map((entry) => entry.text)).toEqual(["Lives in Portugal.", "Lumi fact."]);
  });

  it("lists user entries first, then the Wisp's, oldest first within each", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "W1" }], owner);
    store.apply([{ op: "add", scope: "user", text: "U1" }], owner);
    store.apply([{ op: "add", scope: "wisp", text: "W2" }], owner);
    expect(store.list("lumi").map((entry) => entry.text)).toEqual(["U1", "W1", "W2"]);
  });

  it("patches by superseding the entry with a new one that names it", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "user", text: "Prefers long answers." }], owner);
    const [patched] = store.apply([{ op: "patch", id: "m1", text: "Prefers short answers." }], agent);

    expect(patched).toMatchObject({ id: "m2", scope: "user", replaces: "m1", source: "agent", status: "active" });
    expect(store.list("lumi").map(({ id, status }) => [id, status])).toEqual([
      ["m1", "superseded"],
      ["m2", "active"],
    ]);
    expect(store.active("lumi").map((entry) => entry.id)).toEqual(["m2"]);
  });

  it("removes and restores without deleting", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "Uses Debian." }], owner);
    store.apply([{ op: "remove", id: "m1" }], agent);
    expect(store.active("lumi")).toEqual([]);
    expect(store.list("lumi")[0]?.status).toBe("removed");

    store.apply([{ op: "restore", id: "m1" }], owner);
    expect(store.active("lumi").map((entry) => entry.text)).toEqual(["Uses Debian."]);
    expect(failure(() => store.apply([{ op: "restore", id: "m1" }], owner)).code).toBe("invalid_state");
  });

  it("refuses to change an entry that is not active", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "A" }], owner);
    store.apply([{ op: "remove", id: "m1" }], owner);
    expect(failure(() => store.apply([{ op: "patch", id: "m1", text: "B" }], agent)).code).toBe("invalid_state");
    expect(failure(() => store.apply([{ op: "remove", id: "m1" }], agent)).code).toBe("invalid_state");
  });

  it("rejects exact duplicates in a scope, including a patch to the same text", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "user", text: "Likes tea." }], owner);
    expect(failure(() => store.apply([{ op: "add", scope: "user", text: " Likes tea. " }], agent))).toMatchObject({
      code: "duplicate",
      operation: 0,
    });
    expect(failure(() => store.apply([{ op: "patch", id: "m1", text: "Likes tea." }], agent)).code).toBe("duplicate");
    // The same text in the other scope is a different memory.
    store.apply([{ op: "add", scope: "wisp", text: "Likes tea." }], agent);
  });

  it("refuses to restore an entry whose text is active again", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "A" }], owner);
    store.apply([{ op: "remove", id: "m1" }], owner);
    store.apply([{ op: "add", scope: "wisp", text: "A" }], owner);
    expect(failure(() => store.apply([{ op: "restore", id: "m1" }], owner)).code).toBe("duplicate");
  });

  it("keeps each entry to one line of plain text", () => {
    const { store } = open();
    for (const text of ["", "   ", "two\nlines", "carriage\rreturn", "zero\u200Bwidth", "bidi\u202Eoverride"]) {
      expect(failure(() => store.apply([{ op: "add", scope: "wisp", text }], owner)).code).toBe("invalid_text");
    }
    store.apply([{ op: "add", scope: "wisp", text: "Family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}" }], owner);
  });

  it("refuses credentials from a Wisp, but not the person's own words", () => {
    const { store } = open();
    for (const text of [
      "OpenAI key is sk-proj-abcdefghijklmnopqrstuvwx",
      "GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "AWS key AKIAABCDEFGHIJKLMNOP",
      "password: hunter2hunter2",
      "Senha = minhasenha123",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ]) {
      expect(failure(() => store.apply([{ op: "add", scope: "wisp", text }], agent)).code).toBe("secret");
    }
    store.apply([{ op: "add", scope: "wisp", text: "Rotates the password every month." }], agent);
    store.apply([{ op: "add", scope: "wisp", text: "password: kept-by-the-owner" }], owner);
  });

  it("writes nothing when any operation in a batch fails", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "Keep me." }], owner);
    const details = failure(() =>
      store.apply(
        [
          { op: "remove", id: "m1" },
          { op: "add", scope: "wisp", text: "New." },
          { op: "patch", id: "m99", text: "Missing." },
        ],
        agent,
      ),
    );
    expect(details).toMatchObject({ code: "not_found", operation: 2 });
    expect(store.list("lumi").map(({ id, text, status }) => [id, text, status])).toEqual([
      ["m1", "Keep me.", "active"],
    ]);
    // The failed batch's IDs are not taken.
    expect(store.apply([{ op: "add", scope: "wisp", text: "Next." }], owner)[0]?.id).toBe("m2");
  });

  it("checks a batch without writing it, failing as apply would", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "Kept." }], owner);
    store.check([{ op: "add", scope: "wisp", text: "Checked." }], agent);
    expect(store.list("lumi").map((entry) => entry.text)).toEqual(["Kept."]);
    expect(() => store.check([{ op: "add", scope: "wisp", text: "Kept." }], agent)).toThrow(MemoryError);
    // A check takes no ID.
    expect(store.apply([{ op: "add", scope: "wisp", text: "Next." }], owner)[0]?.id).toBe("m2");
  });

  it("lets later operations in a batch see earlier ones", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "Old." }], owner);
    store.apply(
      [
        { op: "remove", id: "m1" },
        { op: "add", scope: "wisp", text: "Old." },
      ],
      agent,
    );
    expect(store.active("lumi").map(({ id, text }) => [id, text])).toEqual([["m2", "Old."]]);
  });

  it("fails a batch that leaves a scope over its limit, with what it holds and what must go", () => {
    const { store } = open();
    const long = "x".repeat(MEMORY_LIMITS.user - 10);
    store.apply([{ op: "add", scope: "user", text: long }], owner);

    const details = failure(() => store.apply([{ op: "add", scope: "user", text: "y".repeat(25) }], agent));
    expect(details).toMatchObject({ code: "over_limit", scope: "user", limit: MEMORY_LIMITS.user, excess: 15 });
    expect(details.entries?.map((entry) => entry.id)).toEqual(["m1"]);

    // Freeing room in the same batch is enough.
    store.apply(
      [
        { op: "patch", id: "m1", text: "x".repeat(100) },
        { op: "add", scope: "user", text: "y".repeat(25) },
      ],
      agent,
    );
    expect(store.usage("lumi")).toEqual([
      { scope: "user", used: 125, limit: MEMORY_LIMITS.user },
      { scope: "wisp", used: 0, limit: MEMORY_LIMITS.wisp },
    ]);
  });

  it("counts characters as people do", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "café 🙂" }], owner);
    expect(store.usage("lumi")[1]?.used).toBe(6);
  });

  it("allows a batch that shrinks a scope that is already over its limit", () => {
    const { db, store } = open();
    // As a lower limit in a later version would leave it.
    const at = "2026-10-23T12:00:00.000Z";
    const insert = db.prepare(
      "INSERT INTO memory_entries (id, scope, wisp_id, text, source, status, replaces, observed_at, expires_at, created_at, updated_at) VALUES (?, 'user', NULL, ?, 'owner', 'active', NULL, ?, NULL, ?, ?)",
    );
    insert.run("m1", "a".repeat(1000), at, at, at);
    insert.run("m2", "b".repeat(1000), at, at, at);
    db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('next_id', '3')").run();
    store.apply([{ op: "patch", id: "m1", text: "a".repeat(900) }], owner);
    expect(store.usage("lumi")[0]?.used).toBe(1900);
    expect(failure(() => store.apply([{ op: "add", scope: "user", text: "c".repeat(200) }], owner)).code).toBe(
      "over_limit",
    );
  });

  it("leaves expired entries out of the prompt and the limit, but lists them", () => {
    let now = new Date("2026-10-23T12:00:00.000Z");
    const { store } = open(() => now);
    store.apply([{ op: "add", scope: "wisp", text: "Travelling this week.", expiresAt: "2026-10-30" }], owner);
    expect(store.list("lumi")[0]?.expiresAt).toBe("2026-10-30T00:00:00.000Z");
    expect(store.active("lumi")).toHaveLength(1);

    now = new Date("2026-10-31T00:00:00.000Z");
    expect(store.active("lumi")).toEqual([]);
    expect(store.usage("lumi")[1]?.used).toBe(0);
    expect(store.list("lumi")).toHaveLength(1);
    expect(failure(() => store.apply([{ op: "add", scope: "wisp", text: "x", expiresAt: "soon" }], owner)).code).toBe(
      "invalid_text",
    );
  });

  it("deletes only the deleted Wisp's entries", () => {
    const { store } = open();
    store.apply([{ op: "add", scope: "user", text: "Shared." }], owner);
    store.apply([{ op: "add", scope: "wisp", text: "Lumi's." }], owner);
    store.apply([{ op: "add", scope: "wisp", text: "Echo's." }], { wispId: "echo", source: "owner" });
    store.deleteWisp("lumi");
    expect(store.list("lumi").map((entry) => entry.text)).toEqual(["Shared."]);
    expect(store.list("echo").map((entry) => entry.text)).toEqual(["Shared.", "Echo's."]);
  });

  it("joins a transaction the caller already opened", () => {
    const { db, store } = open();
    db.exec("BEGIN");
    store.apply([{ op: "add", scope: "wisp", text: "Inside." }], owner);
    expect(() => store.apply([{ op: "patch", id: "m404", text: "x" }], owner)).toThrow(MemoryError);
    db.exec("ROLLBACK");
    expect(store.list("lumi")).toEqual([]);
  });

  it("keeps its tables and version to itself", () => {
    const { db } = open();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    expect(tables.map((row) => row.name)).toEqual(["memory_entries", "memory_meta"]);
  });

  it("opens an existing database without upgrading or backing it up", () => {
    const { db, store } = open();
    store.apply([{ op: "add", scope: "wisp", text: "Survives." }], owner);
    const beforeUpgrade = vi.fn();
    expect(MemoryStore.open(db, { beforeUpgrade }).list("lumi")).toHaveLength(1);
    expect(beforeUpgrade).not.toHaveBeenCalled();
  });

  it("refuses memory saved by a newer version", () => {
    const { db } = open();
    db.prepare("UPDATE memory_meta SET value = '99' WHERE key = 'schema_version'").run();
    expect(() => MemoryStore.open(db)).toThrow(MemoryNewerSchemaError);
  });
});
