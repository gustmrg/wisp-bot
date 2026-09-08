import { normalizeSelection } from "../../backend/ai-settings-store.js";
import type { ModelSelection } from "../../shared/contracts.js";
import type { ServerDatabase } from "./database.js";

export class SqliteAiSettings {
  constructor(private readonly database: ServerDatabase) {}
  async getSelection(): Promise<ModelSelection | null> {
    const value = this.database.getMeta("modelSelection");
    return value ? normalizeSelection(JSON.parse(value)) : null;
  }
  async setSelection(selection: ModelSelection | null): Promise<void> {
    this.database.transaction(() => {
      this.database.setMeta("modelSelection", JSON.stringify(normalizeSelection(selection)));
      const revision = Number(this.database.getMeta("settingsRevision") ?? 0) + 1;
      this.database.setMeta("settingsRevision", String(revision));
      this.database.appendEvent("settings_changed", { settingsRevision: revision });
    });
  }
}
