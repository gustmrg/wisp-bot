import { ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * A sign-in this device cannot receive the browser's redirect for, such as the
 * browser app or a phone: the user opens the page, approves, and pastes back
 * the address the browser could not load. `onFinish` returns an error message
 * when the address is refused.
 */
export function ManualSignInForm({
  signInUrl,
  onFinish,
}: {
  signInUrl: string;
  onFinish: (redirectUrl: string) => Promise<string | undefined>;
}) {
  const formId = useId();
  const [redirectUrl, setRedirectUrl] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  async function finish() {
    setFinishing(true);
    setError("");
    try {
      const failure = await onFinish(redirectUrl.trim());
      if (failure) setError(failure);
    } catch {
      setError("Could not finish the sign-in.");
    } finally {
      setFinishing(false);
    }
  }

  return (
    <form
      aria-label="Finish sign-in"
      className="flex flex-col gap-2 rounded-[10px] bg-popover p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (redirectUrl.trim() && !finishing) void finish();
      }}
    >
      <p className="m-0">
        <a
          href={signInUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
        >
          Open the sign-in page
          <ExternalLinkIcon className="size-3" aria-hidden="true" />
        </a>
      </p>
      <p className="m-0 text-dim">
        After you approve, the browser goes to an address starting with http://127.0.0.1 that does not load. Copy that
        address from the address bar and paste it here.
      </p>
      <Field>
        <FieldLabel htmlFor={`${formId}-redirect`}>Address after sign-in</FieldLabel>
        <Input
          id={`${formId}-redirect`}
          value={redirectUrl}
          disabled={finishing}
          placeholder="http://127.0.0.1:…/callback?code=…"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setRedirectUrl(event.target.value);
            setError("");
          }}
        />
      </Field>
      {error ? (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={finishing || !redirectUrl.trim()}>
          {finishing ? "Finishing…" : "Finish sign-in"}
        </Button>
      </div>
    </form>
  );
}
