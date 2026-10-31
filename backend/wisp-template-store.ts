import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { BUILTIN_WISP_TEMPLATES } from "../shared/builtin-wisp-templates.js";
import {
  MAX_SAVED_WISP_TEMPLATES,
  MAX_WISP_TEMPLATE_TEXT_LENGTH,
  parseWispTemplate,
  serializeWispTemplate,
  type SaveWispTemplateRequest,
  type WispTemplateEntry,
} from "../shared/wisp-template.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";

const SAVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_SUFFIX = ".json";

/**
 * The Wisp templates of one environment: the built-in ones, which ship with
 * the app and cannot change, and the ones the person saved, one file each in
 * the data directory. Every saved template is checked with `parseWispTemplate`
 * on the way in and again when read, so a file edited by hand that no longer
 * parses is left out rather than trusted.
 */
export class WispTemplateStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<ReadonlyArray<WispTemplateEntry>> {
    const builtIns = BUILTIN_WISP_TEMPLATES.map(({ id, template }) => ({
      id,
      builtIn: true,
      template,
      updatedAt: null,
    }));
    const saved = await this.saved();
    return [
      ...builtIns,
      ...saved.sort((a, b) => a.template.name.localeCompare(b.template.name) || a.id.localeCompare(b.id)),
    ];
  }

  async save(request: SaveWispTemplateRequest): Promise<WispTemplateEntry> {
    const parsed = parseWispTemplate(request.contents);
    if (!parsed.ok) throw new WispBackendError("invalid_request", parsed.error);
    let id = request.id;
    if (id === undefined) {
      if ((await this.saved()).length >= MAX_SAVED_WISP_TEMPLATES) {
        throw new WispBackendError(
          "invalid_request",
          `You can keep at most ${MAX_SAVED_WISP_TEMPLATES} templates. Delete one before saving another.`,
        );
      }
      id = randomUUID();
    } else {
      this.assertSavedId(id);
      if (!(await this.read(id))) throw new WispBackendError("not_found", "This template no longer exists.");
    }
    await mkdir(this.directory, { recursive: true });
    // Written as parsed, so what is stored is only what this app understood.
    await writeFileAtomically(this.file(id), `${serializeWispTemplate(parsed.template)}\n`);
    const entry = await this.read(id);
    if (!entry) throw new WispBackendError("internal_error", "The template could not be saved.");
    return entry;
  }

  async delete(id: string): Promise<void> {
    this.assertSavedId(id);
    if (!(await this.read(id))) throw new WispBackendError("not_found", "This template no longer exists.");
    await rm(this.file(id), { force: true });
  }

  private assertSavedId(id: string): void {
    if (BUILTIN_WISP_TEMPLATES.some((builtIn) => builtIn.id === id)) {
      throw new WispBackendError(
        "invalid_request",
        "Built-in templates cannot be changed. Duplicate it to edit a copy.",
      );
    }
    if (!SAVED_ID.test(id)) throw new WispBackendError("invalid_request", "The template ID is invalid.");
  }

  private file(id: string): string {
    return path.join(this.directory, `${id}${FILE_SUFFIX}`);
  }

  private async saved(): Promise<WispTemplateEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new WispBackendError("internal_error", "The saved templates could not be read.", true);
    }
    const ids = names
      .filter((name) => name.endsWith(FILE_SUFFIX))
      .map((name) => name.slice(0, -FILE_SUFFIX.length))
      .filter((id) => SAVED_ID.test(id));
    const entries = await Promise.all(ids.map((id) => this.read(id)));
    return entries.filter((entry): entry is WispTemplateEntry => entry !== null);
  }

  private async read(id: string): Promise<WispTemplateEntry | null> {
    try {
      const info = await lstat(this.file(id));
      if (!info.isFile() || info.size > MAX_WISP_TEMPLATE_TEXT_LENGTH) return null;
      const parsed = parseWispTemplate(await readFile(this.file(id), "utf8"));
      return parsed.ok ? { id, builtIn: false, template: parsed.template, updatedAt: info.mtime.toISOString() } : null;
    } catch {
      return null;
    }
  }
}
