import { useScreenActions } from "@/features/connections/active-connection";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileUpIcon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";

import type { SkillView } from "../../shared/skills";

/** Same bound the backend applies to a whole SKILL.md. */
const MAX_SKILL_FILE_BYTES = 64 * 1024;
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

export function WispSkillSettings({ conversationId }: { conversationId: string }) {
  const [visited, setVisited] = useState(false);
  return (
    <Accordion
      className="mt-4"
      onValueChange={(values) => {
        if (values.length) setVisited(true);
      }}
    >
      <AccordionItem value="skills">
        <AccordionTrigger>Skills</AccordionTrigger>
        <AccordionContent keepMounted>
          {visited ? <SkillPanel key={conversationId} conversationId={conversationId} /> : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function SkillPanel({ conversationId }: { conversationId: string }) {
  // Opening a folder needs this computer's file manager and the Wisp's files on this computer.
  const screenActions = useScreenActions();
  const [skills, setSkills] = useState<ReadonlyArray<SkillView> | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
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
      setConfirming(null);
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
    <div className="space-y-3 text-sm">
      <p className="text-dim">
        Reusable procedures this Wisp follows when a request matches. Ask the Wisp to save a workflow as a skill; you
        review it before it is saved. You can also import a SKILL.md file you already have.
      </p>
      {skills?.length === 0 ? <p className="text-dim">No skills yet.</p> : null}
      {skills?.length ? (
        <ul className="space-y-2" aria-label="Saved skills">
          {skills.map((skill) => (
            <li key={skill.name} className="space-y-1.5 rounded-md border border-border p-2.5">
              <p className="font-medium">{skill.name}</p>
              <p className="text-dim break-words">{skill.description}</p>
              <details>
                <summary className="cursor-pointer">View instructions</summary>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs">
                  {skill.instructions}
                </pre>
              </details>
              {confirming === skill.name ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(skill.name)}>
                    Delete {skill.name}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(skill.name)}>
                  Delete
                </Button>
              )}
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
        <div role="alert" className="space-y-2 rounded-md border border-border p-2.5">
          <p>{pendingImport.message} Replace it with the file you picked?</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void saveImport(pendingImport.contents, true)}
            >
              Replace skill
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingImport(null)}>
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
        Reload skills
      </Button>
      <p className="text-dim">
        Skills live outside the workspace, so this Wisp's file tools cannot change them. Edits made in the folder apply
        from the next message.
      </p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
