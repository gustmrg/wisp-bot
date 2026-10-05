import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Holds an exclusive SQLite lock on `instance.lock` for the process lifetime,
 * so two servers never share a data directory. The operating system releases
 * the lock if the process dies; nothing depends on PIDs.
 */
export class InstanceLock {
  private constructor(private readonly database: DatabaseSync) {}

  static acquire(dataDirectory: string): InstanceLock {
    const database = new DatabaseSync(path.join(dataDirectory, "instance.lock"));
    try {
      database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE;");
      database.exec("CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY)");
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      database.close();
      if (error instanceof Error && /locked|busy/i.test(error.message)) {
        throw new Error("Another Wisp server is already using this data directory.");
      }
      throw error;
    }
    return new InstanceLock(database);
  }

  release(): void {
    if (!this.database.isOpen) return;
    this.database.exec("ROLLBACK");
    this.database.close();
  }
}
