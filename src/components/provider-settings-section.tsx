import { useCallback, useEffect, useState } from "react";

import type { AiSettingsView, ProviderSummary } from "../../shared/contracts";
import { LogoTile } from "@/components/logo-tile";
import { ClaudeCodeStatus, SubscriptionSignIn } from "@/components/provider-credentials";
import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
  StatusDot,
} from "@/components/settings/settings-primitives";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/ui/secret-input";
import { providerLogo } from "@/lib/provider-logo";
import { notifyProviderCredentialsChanged } from "@/lib/voice-credentials";
import { CLAUDE_CODE_PROVIDER } from "../../shared/claude-code";
import { voiceProvider } from "../../shared/voice";

const SIGN_IN_POLL_MS = 1_500;

/** A provider that can be connected, whichever models it offers. */
type ProviderEntry = Pick<
  ProviderSummary,
  "id" | "name" | "credentialConfigured" | "credentialKind" | "subscriptionSignIn"
> & { decisionOnly: boolean };

/** Providers with text models, then those with only decision models, which `providers` leaves out. */
function providerEntries(view: AiSettingsView): ProviderEntry[] {
  const known = new Set(view.providers.map(({ id }) => id));
  return [
    ...view.providers.map((provider) => ({ ...provider, decisionOnly: false })),
    ...(view.decisionProviders ?? [])
      .filter(({ id }) => !known.has(id))
      .map(({ id, name, credentialConfigured }) => ({
        id,
        name,
        credentialConfigured,
        ...(credentialConfigured ? { credentialKind: "api_key" as const } : {}),
        decisionOnly: true,
      })),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function statusText(entry: ProviderEntry, view: AiSettingsView): string {
  if (entry.id === CLAUDE_CODE_PROVIDER) {
    return view.claudeCode?.state === "ready" ? `Ready · version ${view.claudeCode.version}` : "Not ready";
  }
  const credential = entry.credentialKind === "subscription" ? "Signed in with your subscription" : "API key saved";
  const uses = entry.decisionOnly ? " · Decision models only" : voiceProvider(entry.id) ? " · Also used for voice" : "";
  return `${credential}${uses}`;
}

/** A provider's logo, or the first letter of its name for one without a logo. */
function ProviderLogo({ id, name }: { id: string; name: string }) {
  const logo = providerLogo(id);
  if (logo) return <LogoTile src={logo} className="size-8 rounded-lg p-1" />;
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-medium text-dim"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Lists the providers that are connected, so a key never has to be entered along with a model choice. */
function ProviderSettingsSection() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.wisp.getAiSettings();
      if (result.ok) setView(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not load providers.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A sign-in completes in the browser, so the view is reloaded until it ends.
  const signInWaiting = view?.providerSignIn?.status === "waiting";
  useEffect(() => {
    if (!signInWaiting) return;
    const timer = setInterval(() => {
      void window.wisp
        .getAiSettings()
        .then((result) => {
          if (!result.ok) return;
          setView(result.value);
          if (result.value.providerSignIn?.status !== "waiting") {
            notifyProviderCredentialsChanged();
            setOpenId(null);
          }
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [signInWaiting]);

  const entries = view ? providerEntries(view) : [];
  const connected = entries.filter(({ credentialConfigured }) => credentialConfigured);
  const available = entries.filter(({ credentialConfigured }) => !credentialConfigured);
  const adding = available.find(({ id }) => id === addingId);

  /** A credential changed: the row closes, and its new status says what happened. */
  function handleCredentialChange(next: AiSettingsView, message: string | null): void {
    setView(next);
    setSaved(message);
    setOpenId(null);
    setAddingId(null);
    notifyProviderCredentialsChanged();
  }

  const form = (entry: ProviderEntry) =>
    view ? (
      <ProviderCredentialForm
        entry={entry}
        view={view}
        onViewChange={setView}
        onCredentialChange={handleCredentialChange}
        onCheckAgain={() => void load()}
      />
    ) : null;

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="provider-settings-panel"
      aria-labelledby="provider-settings-title"
    >
      <SettingsPanelTitle id="provider-settings-title" scope="environment">
        Providers
      </SettingsPanelTitle>
      <p className="mb-[22px] text-dim text-xs leading-relaxed">
        Connect the services your models come from. Keys are encrypted and shared with every Wisp.
      </p>

      {!view && !error ? <p className="text-dim text-sm">Loading providers…</p> : null}
      {!view && error ? <p className="text-sm text-destructive">{error}</p> : null}
      {view ? (
        <div>
          {!view.secureStorageAvailable ? (
            <p role="alert" className="mb-3 text-xs leading-relaxed text-destructive">
              Secure credential storage is unavailable. Wisp will not save an API key as plaintext.
            </p>
          ) : null}
          <SettingsGroup label="Connected">
            {connected.length ? (
              <SettingsCard variant="stacked">
                {connected.map((entry) => {
                  const open = openId === entry.id;
                  return (
                    <div key={entry.id}>
                      <SettingsRow>
                        <ProviderLogo id={entry.id} name={entry.name} />
                        <SettingsRowCopy>
                          <SettingsRowTitle>{entry.name}</SettingsRowTitle>
                          <SettingsRowDescription className="flex items-center gap-1.5">
                            <StatusDot tone="success" />
                            {statusText(entry, view)}
                          </SettingsRowDescription>
                        </SettingsRowCopy>
                        <Button
                          type="button"
                          variant="ghost"
                          className="shrink-0"
                          aria-expanded={open}
                          aria-label={`${open ? "Close" : "Manage"} ${entry.name}`}
                          onClick={() => {
                            setSaved(null);
                            setOpenId(open ? null : entry.id);
                          }}
                        >
                          {open ? "Close" : "Manage"}
                        </Button>
                      </SettingsRow>
                      {open ? <div className="border-t border-border">{form(entry)}</div> : null}
                    </div>
                  );
                })}
              </SettingsCard>
            ) : (
              <p className="mx-0.5 my-0 text-xs text-dim">No providers connected yet.</p>
            )}
            <div aria-live="polite" className="mt-2">
              {saved ? <p className="m-0 text-xs text-dim">{saved}</p> : null}
            </div>
          </SettingsGroup>

          {available.length ? (
            <SettingsGroup label="Add a provider">
              <SettingsCard variant="stacked">
                <SettingsRow>
                  <SettingsRowTitle htmlFor="ai-add-provider" className="sr-only">
                    Provider
                  </SettingsRowTitle>
                  <SearchableCombobox
                    id="ai-add-provider"
                    value={adding?.id ?? ""}
                    options={available.map(({ id, name, decisionOnly }) => ({
                      value: id,
                      label: name,
                      iconSrc: providerLogo(id),
                      ...(decisionOnly ? { description: "Decision models only" } : {}),
                    }))}
                    placeholder="Choose a provider"
                    className="h-8 w-full max-w-none shrink text-base"
                    popupMatchesTrigger
                    searchLabel="Search providers"
                    searchPlaceholder="Search providers…"
                    emptyText="No providers found."
                    onChange={(value) => {
                      setSaved(null);
                      setAddingId(value);
                    }}
                  />
                </SettingsRow>
                {adding ? <div key={adding.id}>{form(adding)}</div> : null}
              </SettingsCard>
            </SettingsGroup>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Signs a provider in, or saves, replaces, or removes its API key. */
function ProviderCredentialForm({
  entry,
  view,
  onViewChange,
  onCredentialChange,
  onCheckAgain,
}: {
  entry: ProviderEntry;
  view: AiSettingsView;
  /** A view that leaves the credential as it was, such as a sign-in starting. */
  onViewChange: (view: AiSettingsView) => void;
  onCredentialChange: (view: AiSettingsView, message: string | null) => void;
  onCheckAgain: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (entry.id === CLAUDE_CODE_PROVIDER) {
    return <ClaudeCodeStatus status={view.claudeCode} onCheckAgain={onCheckAgain} />;
  }

  // Servers from before decision models have no way to save a key on its own.
  const canSaveKey = view.decisionProviders !== undefined;
  const id = `ai-provider-key-${entry.id}`;
  const hasKey = entry.credentialKind === "api_key";
  const voice = voiceProvider(entry.id);

  async function run(
    request: () => ReturnType<typeof window.wisp.saveProviderKey>,
    message: string | null,
    failure: string,
  ): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const result = await request();
      if (result.ok) onCredentialChange(result.value, message);
      else setError(result.error.message);
    } catch {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  const removal = () =>
    run(
      () => window.wisp.removeProviderCredential({ providerId: entry.id }),
      null,
      `Could not remove the ${entry.name} credential.`,
    );

  async function signInStep(request: () => ReturnType<typeof window.wisp.startProviderSignIn>, failure: string) {
    setError(null);
    try {
      const result = await request();
      if (result.ok) onViewChange(result.value);
      else setError(result.error.message);
    } catch {
      setError(failure);
    }
  }

  return (
    <div>
      {entry.subscriptionSignIn ? (
        <SubscriptionSignIn
          provider={entry}
          label={entry.subscriptionSignIn.label}
          signIn={view.providerSignIn?.providerId === entry.id ? view.providerSignIn : null}
          disabled={saving || !view.secureStorageAvailable}
          onStart={() =>
            void signInStep(
              () => window.wisp.startProviderSignIn({ providerId: entry.id }),
              "Could not start the sign-in.",
            )
          }
          onCancel={() =>
            void signInStep(
              () => window.wisp.cancelProviderSignIn({ providerId: entry.id }),
              "Could not cancel the sign-in.",
            )
          }
          onFinish={async (redirectUrl) => {
            const result = await window.wisp.finishProviderSignIn({ providerId: entry.id, redirectUrl });
            if (!result.ok) return result.error.message;
            onCredentialChange(result.value, null);
            return undefined;
          }}
          onSignOut={() => void removal()}
        />
      ) : null}
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
        <div className="flex flex-wrap items-start gap-3">
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor={id}>{entry.name} API key</SettingsRowTitle>
            {entry.credentialKind === "subscription" ? (
              <SettingsRowDescription>
                Pays per token instead of your subscription, and replaces the sign-in.
              </SettingsRowDescription>
            ) : null}
          </SettingsRowCopy>
          {hasKey ? (
            <ConfirmAction
              label="Remove key"
              confirmLabel="Remove key"
              variant="ghost"
              className="shrink-0"
              disabled={saving}
              description={
                entry.decisionOnly
                  ? `Circles using a ${entry.name} model answer with their lead until you enter a new key.`
                  : `${voice ? "Voice input and Wisps" : "Wisps"} using ${entry.name} stop working until you enter a new key.`
              }
              onConfirm={() => void removal()}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SecretInput
            id={id}
            autoComplete="new-password"
            value={apiKey}
            disabled={!view.secureStorageAvailable || saving || !canSaveKey}
            placeholder={hasKey ? "Saved — enter a replacement" : "Enter API key"}
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              setError(null);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            className="shrink-0"
            disabled={saving || !apiKey.trim() || !view.secureStorageAvailable || !canSaveKey}
            onClick={() =>
              void run(
                () => window.wisp.saveProviderKey({ providerId: entry.id, apiKey }),
                `${entry.name} API key saved.`,
                `Could not save the ${entry.name} API key.`,
              )
            }
          >
            {saving ? "Saving…" : "Save key"}
          </Button>
        </div>
        {canSaveKey ? null : (
          <p role="alert" className="m-0 text-xs leading-relaxed text-warning">
            Update this server to add keys here.
          </p>
        )}
        {error ? (
          <p role="alert" className="m-0 text-xs leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export { ProviderSettingsSection };
