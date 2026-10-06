import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { LaptopIcon, ServerIcon, SparklesIcon } from "lucide-react";

import type { AiSettingsView } from "../../shared/contracts";
import { missingModelSetup, type SetupRequirement } from "../../shared/setup-status";
import { PROFILE_LIMITS } from "../../shared/user-profile";
import { ModelSettingsSection } from "@/components/model-settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { useConnections } from "@/features/connections/connection-gate";
import { ConnectionsPanel } from "@/features/connections/connections-panel";
import { LOCAL_CONNECTION_ID } from "../../shared/connections";
import { cn } from "@/lib/utils";

type OnboardingStep = "profile" | "model" | "done";

function stepsFor(required: ReadonlyArray<SetupRequirement>): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (required.includes("profile-name")) steps.push("profile");
  if (required.includes("default-model") || required.includes("provider-credential")) steps.push("model");
  return [...steps, "done"];
}

function OnboardingShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background p-6 text-foreground max-[620px]:p-3">
      <section
        className={cn(
          "flex max-h-full w-full flex-col rounded-2xl border border-border bg-card shadow-sm",
          wide ? "max-w-2xl" : "max-w-md",
        )}
        aria-label="Set up Wisp"
      >
        {children}
      </section>
    </main>
  );
}

function StepCount({ index, total }: { index: number; total: number }) {
  return total > 1 ? (
    <p className="m-0 text-[11px] font-medium uppercase tracking-wide text-dim">
      Step {index + 1} of {total}
    </p>
  ) : null;
}

function ProfileStep({ controller, onNext }: { controller: UserProfileController; onNext: () => void }) {
  const [name, setName] = useState(controller.profile.preferredName);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const saved = await controller.save({ ...controller.profile, preferredName: name });
    setSaving(false);
    if (saved) onNext();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="onboarding-name">
        What should Wisps call you?
        <Input
          id="onboarding-name"
          autoComplete="given-name"
          autoFocus
          maxLength={PROFILE_LIMITS.preferredName}
          value={name}
          placeholder="Your name"
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="m-0 text-[11.5px] leading-relaxed text-dim">
        Saved on this device and shared with your Wisps. You can add more about yourself later in Settings.
      </p>
      {controller.error ? (
        <p role="alert" className="m-0 text-[11.5px] text-destructive">
          {controller.error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={!name.trim() || saving}>
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

/** Says where this setup is saved, and lets the person change it. */
function ServerChoice() {
  const [open, setOpen] = useState(false);
  const [view] = useConnections();
  if (!view) return null;
  const server =
    view.activeId === LOCAL_CONNECTION_ID ? undefined : view.profiles.find(({ id }) => id === view.activeId);
  return (
    <div className="min-h-0 overflow-y-auto border-t border-border px-6 py-4">
      {open ? (
        <ConnectionsPanel view={view} />
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 flex items-center gap-2 text-[12px] text-dim">
            {server ? (
              <ServerIcon aria-hidden="true" className="size-4" />
            ) : (
              <LaptopIcon aria-hidden="true" className="size-4" />
            )}
            {server ? `Setting up ${server.name}, a Wisp server.` : "Setting up Wisps on this computer."}
          </p>
          {view.canManage === false ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
              Change
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Onboarding({
  required,
  userProfile,
  onComplete,
}: {
  required: ReadonlyArray<SetupRequirement>;
  userProfile: UserProfileController;
  onComplete: () => void;
}) {
  const [steps] = useState(() => stepsFor(required));
  const [index, setIndex] = useState(0);
  const [modelView, setModelView] = useState<AiSettingsView | null>(null);
  const step = steps[index] ?? "done";
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const modelReady = modelView !== null && missingModelSetup(modelView).length === 0;

  if (step === "model") {
    return (
      <OnboardingShell wide>
        <header className="flex flex-col gap-1 px-[30px] pt-6 max-[620px]:px-4 max-[620px]:pt-5">
          <StepCount index={index} total={steps.length} />
          <h1 className="m-0 text-lg font-semibold">Choose an AI model</h1>
          <p className="m-0 text-sm leading-6 text-dim">
            Wisps need a default model and an API key for its provider before they can respond.
          </p>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <ModelSettingsSection active showHeading={false} onViewChange={setModelView} />
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border px-[30px] py-4 max-[620px]:px-4">
          <p className="m-0 text-[11.5px] text-dim" aria-live="polite">
            {modelReady ? "Model and API key saved." : "Save a model and API key to continue."}
          </p>
          <Button type="button" disabled={!modelReady} onClick={next}>
            Continue
          </Button>
        </footer>
      </OnboardingShell>
    );
  }

  if (step === "profile") {
    return (
      <OnboardingShell>
        <div className="flex flex-col gap-5 p-6">
          <header className="flex flex-col gap-1">
            <StepCount index={index} total={steps.length} />
            <h1 className="m-0 text-lg font-semibold">Welcome to Wisp</h1>
            <p className="m-0 text-sm leading-6 text-dim">Let’s set up the basics before your first Wisp.</p>
          </header>
          <ProfileStep controller={userProfile} onNext={next} />
        </div>
        <ServerChoice />
      </OnboardingShell>
    );
  }

  const name = userProfile.profile.preferredName;
  return (
    <OnboardingShell>
      <div className="flex flex-col gap-5 p-6">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
          <SparklesIcon aria-hidden="true" className="size-5" />
        </div>
        <header className="flex flex-col gap-1">
          <StepCount index={index} total={steps.length} />
          <h1 className="m-0 text-lg font-semibold">{name ? `You’re all set, ${name}` : "You’re all set"}</h1>
          <p className="m-0 text-sm leading-6 text-dim">
            Create your first Wisp to start a conversation. You can change these choices anytime in Settings.
          </p>
        </header>
        <div className="flex justify-end">
          <Button type="button" autoFocus onClick={onComplete}>
            Get started
          </Button>
        </div>
      </div>
    </OnboardingShell>
  );
}

function SetupStatus({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <OnboardingShell>
      <div className="flex flex-col gap-4 p-6" role={message ? "alert" : "status"}>
        <p className={message ? "m-0 text-sm text-destructive" : "m-0 text-sm text-dim"}>
          {message ?? "Loading Wisp…"}
        </p>
        {onRetry ? (
          <div className="flex justify-end">
            <Button type="button" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </OnboardingShell>
  );
}

export { Onboarding, SetupStatus };
