import { useScreenActions } from "@/features/connections/active-connection";
import { useCallback, useEffect, useState } from "react";
import { FolderOpenIcon, RefreshCwIcon } from "lucide-react";

import type { SkillView } from "../../shared/skills";
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
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        Reusable procedures this Wisp follows when a request matches. Ask the Wisp to save a workflow as a skill; you
        review it before it is saved.
      </p>
      {skills?.length === 0 ? <p className="text-muted-foreground">No skills yet.</p> : null}
      {skills?.length ? (
        <ul className="space-y-2" aria-label="Saved skills">
          {skills.map((skill) => (
            <li key={skill.name} className="space-y-1.5 rounded-md border border-border p-2.5">
              <p className="font-medium">{skill.name}</p>
              <p className="text-muted-foreground break-words">{skill.description}</p>
              <details>
                <summary className="cursor-pointer">View instructions</summary>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px]">
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
      <p className="text-muted-foreground">
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
