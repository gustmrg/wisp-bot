import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, CopyIcon, DownloadIcon, PlusIcon, SearchIcon, UploadIcon } from "lucide-react";

import { MarkdownView } from "@/components/markdown-view";
import { ConfirmAction, SettingsCard, SettingsGroup } from "@/components/settings/settings-primitives";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Wisp } from "@/components/wisp";
import { downloadTextFile } from "@/lib/download-file";
import type { TemplateUseResult } from "@/lib/create-wisp-from-template";
import { WISP_NAME_MAX_LENGTH } from "../../shared/conversations";
import { pluginCatalogEntry } from "../../shared/plugins";
import { parseSkillFile } from "../../shared/skills";
import { serializeWispTemplate, type WispTemplate, type WispTemplateEntry } from "../../shared/wisp-template";
import { formatBytes } from "../../shared/workspace";

type TemplateFilter = "all" | "builtin" | "saved";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "builtin", label: "Built in" },
  { value: "saved", label: "Yours" },
] as const;

/** Shown when the server predates templates. */
const UNSUPPORTED = "This server is older than this app and has no templates. Update the server to use them.";

/**
 * The Wisp templates of the active environment: the built-in ones and the
 * ones saved here, like a small gallery of Wisps ready for a job. Each can be
 * previewed in full. **Use** creates the Wisp at once, and **Customize** opens
 * the creation dialog filled in, to change anything first. Built-in ones only
 * come with the app, so importing, duplicating, exporting, renaming and deleting
 * belong to the saved ones. The panel keeps room for its scrollbar, so a filter
 * with fewer cards does not change the search's width.
 */
export function TemplateSettingsSection({
  onUseTemplate,
  onCustomizeTemplate,
  onOpenModelSettings,
  onClose,
}: {
  /** Creates a Wisp from a template; without it there is no Use button. */
  onUseTemplate?: (entry: WispTemplateEntry) => Promise<TemplateUseResult>;
  /** Opens the creation dialog filled in from a template; without it there is no Customize button. */
  onCustomizeTemplate?: ((entry: WispTemplateEntry) => void) | undefined;
  onOpenModelSettings?: () => void;
  onClose?: () => void;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<WispTemplateEntry> | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TemplateFilter>("all");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [usingId, setUsingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TemplateUseResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void window.wisp
      .listWispTemplates()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setEntries(result.value);
          setLoadError("");
        } else setLoadError(result.error.code === "unsupported" ? UNSUPPORTED : result.error.message);
      })
      .catch(() => {
        if (active) setLoadError("Could not load the templates.");
      });
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (entries ?? []).filter(
      ({ builtIn, template }) =>
        (filter === "all" || (filter === "builtin") === builtIn) &&
        (!needle ||
          [template.name, template.role, template.description ?? ""].some((text) =>
            text.toLowerCase().includes(needle),
          )),
    );
  }, [entries, query, filter]);
  const previewed = entries?.find(({ id }) => id === previewId);

  /** Saves a template and opens it, so an import or a copy lands where the person can check it. */
  async function save(contents: string, id?: string): Promise<boolean> {
    setMessage("");
    try {
      const result = await window.wisp.saveWispTemplate({ contents, ...(id ? { id } : {}) });
      if (!result.ok) {
        setMessage(result.error.message);
        return false;
      }
      setEntries((current) => [...(current ?? []).filter((entry) => entry.id !== result.value.id), result.value]);
      setPreviewId(result.value.id);
      return true;
    } catch {
      setMessage("Could not save the template.");
      return false;
    }
  }

  async function importFile(file: File) {
    // Read here and sent as text: the renderer never hands the server a path.
    const saved = await save(await file.text());
    // Back from its preview, the list has to show what was just imported.
    if (saved && filter === "builtin") setFilter("saved");
  }

  async function remove(id: string) {
    setMessage("");
    try {
      const result = await window.wisp.deleteWispTemplate({ id });
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setPreviewId(null);
      setEntries((current) => (current ?? []).filter((entry) => entry.id !== id));
    } catch {
      setMessage("Could not delete the template.");
    }
  }

  async function use(entry: WispTemplateEntry) {
    if (!onUseTemplate || usingId) return;
    setOutcome(null);
    setUsingId(entry.id);
    try {
      const result = await onUseTemplate(entry);
      // With nothing to say, the new Wisp's conversation is what comes next.
      if (result.status === "created" && !result.notices.length) onClose?.();
      else setOutcome(result);
    } finally {
      setUsingId(null);
    }
  }

  /**
   * A skill becomes the Wisp's standing instructions, so the person approves
   * its exact content (ADR 008). Built-in ones come with the app; a saved one
   * may come from a file, so its preview opens first, and choosing there is
   * the approval.
   */
  function fromCard(entry: WispTemplateEntry, choose: (chosen: WispTemplateEntry) => void) {
    if (!entry.builtIn && entry.template.skills?.length) setPreviewId(entry.id);
    else choose(entry);
  }

  return (
    <section
      id="template-settings-panel"
      aria-labelledby="template-settings-title"
      className="min-w-0 overflow-y-auto [scrollbar-gutter:stable] px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
    >
      <SettingsPanelTitle id="template-settings-title" scope="environment">
        Templates
      </SettingsPanelTitle>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Ready-made Wisps, each with a specialty. Use one to start right away.
      </p>
      {outcome ? <UseOutcome outcome={outcome} onOpenModelSettings={onOpenModelSettings} onClose={onClose} /> : null}
      {previewed ? (
        <TemplatePreview
          key={previewed.id}
          entry={previewed}
          onBack={() => {
            setPreviewId(null);
            setMessage("");
          }}
          {...(onUseTemplate ? { onUse: (chosen: WispTemplateEntry) => void use(chosen), usingId } : {})}
          {...(onCustomizeTemplate ? { onCustomize: onCustomizeTemplate } : {})}
          onSave={save}
          onDelete={remove}
          message={message}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim"
              />
              <Input
                aria-label="Search templates"
                placeholder="Search"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <SegmentedControl label="Show" value={filter} options={FILTER_OPTIONS} onChange={setFilter} />
            <Button variant="outline" size="sm" disabled={!entries} onClick={() => fileInput.current?.click()}>
              <UploadIcon data-icon="inline-start" aria-hidden="true" />
              Import
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importFile(file);
              }}
            />
          </div>
          {message ? (
            <p role="alert" className="mb-3 mt-0 text-xs text-destructive">
              {message}
            </p>
          ) : null}
          {loadError ? (
            <p role="alert" className="m-0 text-xs text-destructive">
              {loadError}
            </p>
          ) : !entries ? (
            <p role="status" className="m-0 text-xs text-dim">
              Loading templates…
            </p>
          ) : visible.length === 0 ? (
            <p className="m-0 text-xs text-dim">
              {filter === "saved" && !query.trim()
                ? "No saved templates yet. Save a Wisp as a template from its settings, or import one."
                : "No template matches. Clear the search to see them all."}
            </p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 max-[620px]:grid-cols-1">
              {visible.map((entry) => (
                <li key={entry.id}>
                  <TemplateCard
                    entry={entry}
                    onOpen={() => setPreviewId(entry.id)}
                    {...(onUseTemplate
                      ? { onUse: (chosen: WispTemplateEntry) => fromCard(chosen, (next) => void use(next)), usingId }
                      : {})}
                    {...(onCustomizeTemplate
                      ? { onCustomize: (chosen: WispTemplateEntry) => fromCard(chosen, onCustomizeTemplate) }
                      : {})}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Who made a template and what it starts a Wisp with, in a few words. */
function templateSummary({ builtIn, template }: WispTemplateEntry): string {
  const skills = template.skills?.length ?? 0;
  return [builtIn ? "Built in" : "Yours", template.role, skills ? `${skills} ${skills === 1 ? "skill" : "skills"}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** What came of using a template, when there is more to say than opening the new Wisp. */
function UseOutcome({
  outcome,
  onOpenModelSettings,
  onClose,
}: {
  outcome: TemplateUseResult;
  onOpenModelSettings?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  if (outcome.status === "failed") {
    return (
      <p role="alert" className="mb-3 mt-0 text-xs text-destructive">
        {outcome.message}
      </p>
    );
  }
  return (
    <SettingsCard className="mb-4 flex flex-wrap items-center gap-3 p-3.5" role="status">
      <div className="min-w-0 flex-1 space-y-1 text-xs leading-relaxed">
        {outcome.status === "needs_model" ? (
          <p className="m-0">Choose a default model first, so your new Wisp can respond.</p>
        ) : (
          <>
            <p className="m-0 font-medium">{outcome.name} is ready.</p>
            {outcome.notices.map((notice) => (
              <p key={notice} className="m-0 text-dim">
                {notice}
              </p>
            ))}
          </>
        )}
      </div>
      {outcome.status === "needs_model" ? (
        <Button size="sm" onClick={onOpenModelSettings}>
          Open AI Model
        </Button>
      ) : (
        <Button size="sm" onClick={onClose}>
          Open {outcome.name}
        </Button>
      )}
    </SettingsCard>
  );
}

function TemplateCard({
  entry,
  onOpen,
  onUse,
  onCustomize,
  usingId,
}: {
  entry: WispTemplateEntry;
  onOpen: () => void;
  onUse?: (entry: WispTemplateEntry) => void;
  onCustomize?: (entry: WispTemplateEntry) => void;
  usingId?: string | null;
}) {
  const { template } = entry;
  return (
    <SettingsCard className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <Wisp
          aria-hidden="true"
          className="flex-none"
          name={template.name}
          {...(template.appearance ? { appearance: template.appearance } : {})}
          {...(template.color ? { color: template.color } : {})}
        />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-bold hover:underline"
          aria-label={`Preview ${template.name}`}
          onClick={onOpen}
        >
          {template.name}
        </button>
      </div>
      <p className="m-0 line-clamp-2 flex-1 text-xs leading-relaxed">{template.description || "No description."}</p>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <p className="m-0 min-w-0 text-2xs text-dim">{templateSummary(entry)}</p>
        <div className="ml-auto flex flex-none items-center gap-1.5">
          {onCustomize ? (
            <Button
              className="template-card-action"
              variant="ghost"
              size="sm"
              aria-label={`Customize ${template.name}`}
              disabled={Boolean(usingId)}
              onClick={() => onCustomize(entry)}
            >
              Customize
            </Button>
          ) : null}
          {onUse ? (
            <Button
              className="template-card-action"
              variant="outline"
              size="sm"
              aria-label={`Use ${template.name}`}
              disabled={Boolean(usingId)}
              onClick={() => onUse(entry)}
            >
              {usingId === entry.id ? "Creating…" : "Use"}
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsCard>
  );
}

/** A file name for an exported template: its name in kebab case. */
function exportFileName(template: WispTemplate): string {
  const slug = template.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "wisp"}.wisp-template.json`;
}

function TemplatePreview({
  entry,
  onBack,
  onUse,
  onCustomize,
  usingId,
  onSave,
  onDelete,
  message,
}: {
  entry: WispTemplateEntry;
  onBack: () => void;
  onUse?: (entry: WispTemplateEntry) => void;
  onCustomize?: (entry: WispTemplateEntry) => void;
  usingId?: string | null;
  onSave: (contents: string, id?: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  message: string;
}) {
  const { template, builtIn } = entry;
  const [name, setName] = useState(template.name);
  const [busy, setBusy] = useState(false);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }

  const copyName = `${template.name} copy`.slice(0, WISP_NAME_MAX_LENGTH);
  return (
    <div className="space-y-4">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeftIcon aria-hidden="true" />
        All templates
      </Button>
      <div className="flex flex-wrap items-center gap-3">
        <Wisp
          aria-hidden="true"
          size="lg"
          className="flex-none"
          name={template.name}
          {...(template.appearance ? { appearance: template.appearance } : {})}
          {...(template.color ? { color: template.color } : {})}
        />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 truncate text-base font-semibold">{template.name}</h3>
          <p className="m-0 text-xs text-dim">{templateSummary(entry)}</p>
        </div>
        {onCustomize ? (
          <Button variant="outline" disabled={busy || Boolean(usingId)} onClick={() => onCustomize(entry)}>
            Customize
          </Button>
        ) : null}
        {onUse ? (
          <Button disabled={busy || Boolean(usingId)} onClick={() => onUse(entry)}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            {usingId === entry.id ? "Creating…" : "Use template"}
          </Button>
        ) : null}
      </div>
      {template.description ? <p className="m-0 text-sm">{template.description}</p> : null}
      {builtIn ? null : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => onSave(serializeWispTemplate({ ...template, name: copyName })))}
            >
              <CopyIcon data-icon="inline-start" aria-hidden="true" />
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadTextFile(exportFileName(template), serializeWispTemplate(template), "application/json")
              }
            >
              <DownloadIcon data-icon="inline-start" aria-hidden="true" />
              Export
            </Button>
            <ConfirmAction
              label="Delete"
              confirmLabel={`Delete ${template.name}`}
              pending={busy}
              variant="outline"
              description="Wisps made from it keep everything they were given."
              onConfirm={() => void run(() => onDelete(entry.id))}
            />
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed || trimmed === template.name) return;
              void run(() => onSave(serializeWispTemplate({ ...template, name: trimmed }), entry.id));
            }}
          >
            <Input
              aria-label="Template name"
              className="max-w-64"
              maxLength={WISP_NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              size="sm"
              type="submit"
              variant="outline"
              disabled={busy || !name.trim() || name.trim() === template.name}
            >
              Rename
            </Button>
          </form>
        </>
      )}
      {message ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {message}
        </p>
      ) : null}

      <SettingsGroup label="Soul">
        <SettingsCard className="p-4 text-sm">
          {template.soul.trim() ? <MarkdownView text={template.soul} /> : <p className="m-0 text-dim">No soul.</p>}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup label="Skills">
        {template.skills?.length ? (
          <SettingsCard variant="stacked">
            {template.skills.map(({ contents }) => {
              const skill = parseSkillFile(contents);
              return (
                <details key={skill?.name ?? contents} className="px-3.5 py-2.5 text-xs">
                  <summary className="cursor-pointer">
                    <span className="font-medium">{skill?.name}</span>
                    <span className="text-dim"> · {skill?.description}</span>
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-2xs">
                    {contents}
                  </pre>
                </details>
              );
            })}
          </SettingsCard>
        ) : (
          <SettingsCard className="p-4 text-sm">
            <p className="m-0 text-dim">No skills.</p>
          </SettingsCard>
        )}
      </SettingsGroup>

      <SettingsGroup label="Settings">
        <SettingsCard className="space-y-1.5 p-4 text-xs">
          <p className="m-0">
            <span className="text-dim">Model: </span>
            {template.model
              ? `${template.model.modelId} (${template.model.providerId})${
                  template.model.thinkingLevel ? ` · ${template.model.thinkingLevel} reasoning` : ""
                }`
              : "Your default model"}
          </p>
          <p className="m-0">
            <span className="text-dim">Workspace: </span>
            {template.setup?.quotaBytes === null
              ? "Unlimited"
              : template.setup?.quotaBytes
                ? formatBytes(template.setup.quotaBytes)
                : "The default size"}
            {template.setup?.executionMode === "container" ? " · runs commands in a container" : ""}
          </p>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup label="Access it asks for">
        <TemplateAccess template={template} />
      </SettingsGroup>
    </div>
  );
}

const FILE_LABELS = { create_file: "Create files", modify_file: "Edit files" } as const;
const BEHAVIOR_LABELS = { allow: "Allow", ask: "Ask", block: "Block" } as const;

function TemplateAccess({ template }: { template: WispTemplate }) {
  const access = template.access;
  const lines = [
    ...Object.entries(access?.files ?? {}).map(
      ([category, behavior]) =>
        `${FILE_LABELS[category as keyof typeof FILE_LABELS]}: ${BEHAVIOR_LABELS[behavior as keyof typeof BEHAVIOR_LABELS]}`,
    ),
    ...(access?.allowEverything ? ["Allow everything (risk mode)"] : []),
    ...(access?.plugins ?? []).map(
      ({ pluginId, access: level }) =>
        `${pluginCatalogEntry(pluginId).name}: ${level === "write" ? "read and write" : "read"}`,
    ),
    ...(access?.mcpServers ?? []).map(
      ({ name, access: level }) => `${name}: ${level === "allow_all" ? "use without asking" : "use with approval"}`,
    ),
  ];
  if (!lines.length) {
    return (
      <SettingsCard className="p-4 text-sm">
        <p className="m-0 text-dim">None.</p>
      </SettingsCard>
    );
  }
  return (
    <>
      <SettingsCard variant="stacked">
        {lines.map((line) => (
          <p key={line} className="m-0 px-3.5 py-2.5 text-xs">
            {line}
          </p>
        ))}
      </SettingsCard>
      {/* The list reads like what the Wisp will get, and Allow everything is on it, so this says it is only a request. */}
      <p className="mx-0.5 mt-[7px] text-xs text-dim">
        Nothing here is granted by the template. Turn on what you want with Customize, or later in the Wisp's Access
        tab.
      </p>
    </>
  );
}
