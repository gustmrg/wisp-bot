import type { ProviderSignInView, ProviderSummary } from "../../shared/contracts";
import { ManualSignInForm } from "@/components/manual-sign-in";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import {
  CLAUDE_CODE_PLAN_USAGE_SHOWN_FROM,
  claudeCodeUnavailableMessage,
  type ClaudeCodePlanUsageView,
  type ClaudeCodeStatusView,
} from "../../shared/claude-code";

/**
 * Signs a provider in with the person's subscription instead of an API key.
 * Requests then count against the plan's usage limits rather than being billed
 * per token.
 */
export function SubscriptionSignIn({
  provider,
  label,
  signIn,
  disabled,
  onStart,
  onCancel,
  onFinish,
  onSignOut,
}: {
  provider: Pick<ProviderSummary, "name" | "credentialKind">;
  label: string;
  signIn: ProviderSignInView | null;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onFinish: (redirectUrl: string) => Promise<string | undefined>;
  onSignOut: () => void;
}) {
  const signedIn = provider.credentialKind === "subscription";
  const waiting = signIn?.status === "waiting";
  return (
    <div className="flex flex-col gap-3 border-b border-border px-3.5 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <SettingsRowCopy>
          <SettingsRowTitle>Subscription</SettingsRowTitle>
          <SettingsRowDescription>
            {signedIn
              ? `Signed in. Wisps using ${provider.name} count against your subscription's usage limits instead of being billed per token.`
              : waiting
                ? "Finish signing in in your browser."
                : `Use your ${provider.name} subscription instead of an API key. Requests count against your plan's usage limits instead of being billed per token.${provider.credentialKind === "api_key" ? " Signing in replaces the saved API key." : ""}`}
          </SettingsRowDescription>
        </SettingsRowCopy>
        {signedIn && !waiting ? (
          <ConfirmAction
            label="Sign out"
            confirmLabel="Sign out"
            variant="ghost"
            className="shrink-0"
            disabled={disabled}
            description={`Wisps using ${provider.name} stop working until you sign in again or enter an API key.`}
            onConfirm={onSignOut}
          />
        ) : null}
        {waiting ? (
          <Button type="button" variant="ghost" className="shrink-0" onClick={onCancel}>
            Cancel
          </Button>
        ) : signedIn ? null : (
          <Button type="button" variant="secondary" className="shrink-0" disabled={disabled} onClick={onStart}>
            {label}
          </Button>
        )}
      </div>
      {waiting && signIn.signInUrl ? <ManualSignInForm signInUrl={signIn.signInUrl} onFinish={onFinish} /> : null}
      {signIn?.status === "failed" ? (
        <p role="alert" className="m-0 text-xs leading-relaxed text-destructive">
          {signIn.error ?? "The sign-in did not complete."}
        </p>
      ) : null}
    </div>
  );
}

const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/setup";

/**
 * Whether the server's Claude Code can run Wisps. Wisp never signs in to
 * Claude itself: the person signs in to Claude Code on the server's computer,
 * and Wisps there use that sign-in (ADR 026).
 */
export function ClaudeCodeStatus({
  status,
  onCheckAgain,
}: {
  status: ClaudeCodeStatusView | undefined;
  onCheckAgain: () => void;
}) {
  const ready = status?.state === "ready" ? status : undefined;
  const plan = ready?.plan ? `${ready.plan.charAt(0).toUpperCase()}${ready.plan.slice(1)} ` : "";
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <SettingsRowCopy>
          <SettingsRowTitle>{ready ? `Claude Code ${ready.version}` : "Claude Code"}</SettingsRowTitle>
          <SettingsRowDescription>
            {ready
              ? ready.billing === "subscription"
                ? `Runs on Claude Code with your Claude ${plan}plan. Wisps on it count against your plan's usage limits.`
                : "Runs on Claude Code signed in with an Anthropic API account, billed per token."
              : claudeCodeUnavailableMessage(status)}
          </SettingsRowDescription>
        </SettingsRowCopy>
        {ready ? null : (
          <Button type="button" variant="secondary" className="shrink-0" onClick={onCheckAgain}>
            Check again
          </Button>
        )}
      </div>
      {status?.state === "missing" ? (
        <p className="m-0 text-xs leading-relaxed text-dim">
          Install it on the computer that runs Wisp by following{" "}
          <a
            href={CLAUDE_CODE_SETUP_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Claude Code's setup guide
          </a>
          , then sign in with <code>claude auth login</code>.
        </p>
      ) : null}
      {ready ? null : (
        <p className="m-0 text-xs leading-relaxed text-dim">
          Wisp never asks for your Claude password or token: Claude Code keeps its own sign-in.
        </p>
      )}
      {ready?.planUsage ? <ClaudePlanUsage usage={ready.planUsage} /> : null}
    </div>
  );
}

/** Claude Code's status as a settings group, for the form that chooses it. */
export function ClaudeCodeStatusCard(props: { status: ClaudeCodeStatusView | undefined; onCheckAgain: () => void }) {
  return (
    <SettingsGroup label="Claude Code">
      <SettingsCard>
        <ClaudeCodeStatus {...props} />
      </SettingsCard>
    </SettingsGroup>
  );
}

const PLAN_WINDOW_NAMES = { five_hour: "5-hour", seven_day: "Weekly" } as const;

/** The plan's usage limits the latest turn reported, shown once one is nearly used up. */
function ClaudePlanUsage({ usage }: { usage: ClaudeCodePlanUsageView }) {
  const shown = usage.windows.filter(
    ({ utilization }) => usage.limited || utilization >= CLAUDE_CODE_PLAN_USAGE_SHOWN_FROM,
  );
  if (!shown.length) return null;
  return (
    <ul aria-label="Claude plan usage" className="m-0 list-none space-y-0.5 p-0 text-xs leading-relaxed text-warning">
      {shown.map(({ window, utilization, resetsAt }) => (
        <li key={window}>
          {PLAN_WINDOW_NAMES[window]} limit {Math.round(utilization * 100)}% used, resets{" "}
          {new Date(resetsAt).toLocaleString([], {
            ...(window === "seven_day" ? { weekday: "short" as const } : {}),
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </li>
      ))}
    </ul>
  );
}
