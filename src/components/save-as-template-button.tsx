import { useEffect, useState } from "react";
import { CheckIcon, LayoutTemplateIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureWispTemplate } from "@/lib/wisp-template-actions";
import type { Wisp } from "../../shared/conversations";
import { serializeWispTemplate } from "../../shared/wisp-template";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const LABELS: Record<SaveStatus, string> = {
  idle: "Save as template",
  saving: "Saving template…",
  saved: "Saved to Templates",
  error: "Could not save template",
};

/**
 * Saves the Wisp as it is now, skills, setup and access included, among the
 * templates of the server it runs on. Without `className` it is a button like
 * the panel's others; with it, a plain button styled by its list.
 */
export function SaveAsTemplateButton({
  conversationId,
  wisp,
  className,
}: {
  conversationId: string;
  wisp: Wisp;
  className?: string;
}) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (status !== "saved") return;
    const timer = setTimeout(() => setStatus("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [status]);

  async function save() {
    setStatus("saving");
    setError("");
    try {
      const template = await captureWispTemplate(conversationId, wisp);
      const result = await window.wisp.saveWispTemplate({ contents: serializeWispTemplate(template) });
      if (result.ok) setStatus("saved");
      else {
        setError(result.error.message);
        setStatus("error");
      }
    } catch {
      setError("Could not save the template.");
      setStatus("error");
    }
  }

  const icon = status === "saved" ? <CheckIcon aria-hidden="true" /> : <LayoutTemplateIcon aria-hidden="true" />;
  return (
    <>
      {/* Present only while it has something to say, beside the panel's other status regions. */}
      {status === "error" || status === "saved" ? (
        <span className="sr-only" role={status === "error" ? "alert" : "status"}>
          {status === "error" ? error : `${wisp.name} was saved as a template.`}
        </span>
      ) : null}
      {className ? (
        <button type="button" className={className} disabled={status === "saving"} onClick={() => void save()}>
          {icon}
          <span className="flex-1">{LABELS[status]}</span>
        </button>
      ) : (
        <Button variant="secondary" type="button" disabled={status === "saving"} onClick={() => void save()}>
          {icon}
          {LABELS[status]}
        </Button>
      )}
    </>
  );
}
