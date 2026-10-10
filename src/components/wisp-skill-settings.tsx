import { useScreenActions } from "@/features/connections/active-connection";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileUpIcon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";

import type { SkillView } from "../../shared/skills";

/** Same bound the backend applies to a whole SKILL.md. */
const MAX_SKILL_FILE_BYTES = 64 * 1024;
import { ConfirmAction } from "@/components/settings/settings-primitives";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";

export function WispSkillSettings({ conversationId }: { conversationId: string }) {
  const [visited, setVisited] = useState(false);
  return (
    <AccordionItem
      value="skills"
      onOpenChange={(open) => {
        if (open) setVisited(true);
      }}
    >
      <AccordionTrigger>Skills</AccordionTrigger>
      <AccordionContent keepMounted>
        {visited ? <SkillPanel key={conversationId} conversationId={conversationId} /> : null}
      </AccordionContent>
    </AccordionItem>
  );
}

function SkillPanel({ conversationId }: { conversationId: string }) {
  // Opening a folder needs this computer's file manager and the Wisp's files on this computer.
  const screenActions = useScreenActions();
  const [skills, setSkills] = useState<ReadonlyArray<SkillView> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A picked file whose skill name is already taken, waiting for the user to confirm the replacement.
  const [pendingImport, setPendingImport] = useState<{ contents: string; message: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await window.wisp.listSkills({ conversationId });
      if (result.ok) {
        setSkills(result.value);
        setError("");
      } else setError(result.error.message);
    } catch {
      setError("Could not load skills.");
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    // A skill the Wisp just saved shows up without reopening settings.
    return window.wisp.subscribeToAgentEvents((event) => {
      if (
        event.conversationId === conversationId &&
        event.type === "tool_activity" &&
        event.toolName === "save_skill" &&
        event.phase === "completed"
      ) {
        void load();
      }
    });
  }, [conversationId, load]);

  async function remove(name: string) {
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.deleteSkill({ conversationId, name });
      if (result.ok) setSkills(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not delete the skill.");
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setPendingImport(null);
    setError("");
    if (file.size > MAX_SKILL_FILE_BYTES) {
      setError(`A skill file can be at most ${MAX_SKILL_FILE_BYTES / 1024} KiB.`);
      return;
    }
    let contents: string;
    try {
      contents = await file.text();
    } catch {
      setError("Could not read the file.");
      return;
    }
    await saveImport(contents, false);
  }

  async function saveImport(contents: string, replace: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.importSkill({ conversationId, contents, ...(replace ? { replace } : {}) });
      if (result.ok) {
        setSkills(result.value);
        setPendingImport(null);
      } else if (result.error.code === "already_exists") {
        setPendingImport({ contents, message: result.error.message });
      } else {
        setPendingImport(null);
        setError(result.error.message);
      }
    } catch {
      setError("Could not import the skill.");
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    setError("");
    try {
      const result = await window.wisp.openSkillsFolder({ conversationId });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Could not open the folder.");
    }
  }

  return (
    <FieldGroup className="gap-3">
      <FieldDescription>
        Reusable procedures this Wisp follows when a request matches. Ask the Wisp to save a workflow as a skill; you
        review it before it is saved. You can also import a SKILL.md file you already have.
      </FieldDescription>
      <FieldDescription>
        Skills live outside the workspace, so this Wisp's file tools cannot change them. Edits made in the folder apply
        from the next message.
      </FieldDescription>
      {skills === null && !error ? <FormStatus pending="Loading skills…" /> : null}
      {skills?.length === 0 ? <FieldTitle>No skills yet.</FieldTitle> : null}
      {skills?.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Saved skills">
          {skills.map((skill) => (
            <li key={skill.name} className="flex flex-col gap-1.5 rounded-[10px] border border-border p-3 text-sm">
              <p className="m-0 font-medium">{skill.name}</p>
              <FieldDescription className="break-words">{skill.description}</FieldDescription>
              <details>
                <summary className="cursor-pointer text-xs text-dim">View instructions</summary>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs">
                  {skill.instructions}
                </pre>
              </details>
              <ConfirmAction
                label="Delete"
                confirmLabel={`Delete ${skill.name}`}
                variant="ghost"
                className="self-start"
                disabled={busy}
                description="The Wisp stops following this skill from the next message. This cannot be undone."
                onConfirm={() => void remove(skill.name)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept=".md,text/markdown"
        className="hidden"
        aria-label="SKILL.md file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Cleared so picking the same file again still fires a change.
          event.currentTarget.value = "";
          if (file) void importFile(file);
        }}
      />
      {pendingImport ? (
        <div
          role="alert"
          className="flex flex-col gap-2.5 rounded-[10px] border border-destructive/30 bg-destructive/5 p-3"
        >
          <p className="m-0 text-xs leading-relaxed">{pendingImport.message} Replace it with the file you picked?</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" disabled={busy} onClick={() => void saveImport(pendingImport.contents, true)}>
              Replace skill
            </Button>
            <Button variant="ghost" onClick={() => setPendingImport(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <Button className="w-full" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
        <FileUpIcon aria-hidden="true" />
        Import SKILL.md
      </Button>
      {screenActions ? (
        <Button className="w-full" variant="outline" onClick={() => void openFolder()}>
          <FolderOpenIcon aria-hidden="true" />
          Open skills folder
        </Button>
      ) : null}
      <Button className="w-full" variant="ghost" onClick={() => void load()}>
        <RefreshCwIcon aria-hidden="true" />
        {skills === null && error ? "Retry" : "Reload skills"}
      </Button>
      <FormStatus error={error} />
    </FieldGroup>
  );
}
