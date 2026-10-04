import { useState } from "react";
import { normalizeUserProfile, PROFILE_LIMITS } from "../../shared/user-profile";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { SettingsCard, SettingsField, SettingsGroup } from "@/components/settings/settings-primitives";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export function UserProfileSettings({ controller }: { controller: UserProfileController }) {
  const [draft, setDraft] = useState(controller.profile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(controller.profile);
  const nameMissing = !draft.preferredName.trim();
  return (
    <SettingsGroup label="Your profile">
      <SettingsCard>
        <form
          className="flex flex-col gap-3 px-3.5 py-3.5"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            const success = await controller.save(draft);
            if (success) setDraft(normalizeUserProfile(draft));
            setSaved(success);
            setSaving(false);
          }}
        >
          <p className="m-0 text-[11.5px] leading-relaxed text-dim">
            Saved on this device. Shared with your Wisps to personalize responses, including with their AI provider when
            you chat.
          </p>
          <fieldset disabled={saving || controller.loading} className="m-0 flex min-w-0 flex-col border-0 p-0">
            <SettingsField label="Preferred name" htmlFor="profile-name">
              <Input
                id="profile-name"
                autoComplete="given-name"
                maxLength={PROFILE_LIMITS.preferredName}
                value={draft.preferredName}
                placeholder="What should Wisps call you?"
                onChange={(event) => {
                  setDraft({ ...draft, preferredName: event.target.value });
                  setSaved(false);
                }}
              />
            </SettingsField>
            <SettingsField label="About you (optional)" htmlFor="profile-about">
              <Textarea
                id="profile-about"
                maxLength={PROFILE_LIMITS.aboutYou}
                value={draft.aboutYou}
                placeholder="For example: I’m a backend developer working mainly with .NET."
                onChange={(event) => {
                  setDraft({ ...draft, aboutYou: event.target.value });
                  setSaved(false);
                }}
              />
            </SettingsField>
            <SettingsField label="Response preferences (optional)" htmlFor="profile-responses">
              <Textarea
                id="profile-responses"
                maxLength={PROFILE_LIMITS.responsePreferences}
                value={draft.responsePreferences}
                placeholder="For example: Be concise, respond in Portuguese, and explain technical tradeoffs."
                onChange={(event) => {
                  setDraft({ ...draft, responsePreferences: event.target.value });
                  setSaved(false);
                }}
              />
            </SettingsField>
            <div className="flex justify-end">
              <Button type="submit" disabled={!dirty || nameMissing}>
                {saving ? "Saving…" : "Save profile"}
              </Button>
            </div>
          </fieldset>
          {nameMissing ? (
            <p role="alert" className="m-0 text-[11.5px] text-destructive">
              Your preferred name is required.
            </p>
          ) : null}
          {controller.error ? (
            <p role="alert" className="m-0 text-[11.5px] text-destructive">
              {controller.error}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="m-0 text-[11.5px] text-dim">
              Profile saved.
            </p>
          ) : null}
        </form>
      </SettingsCard>
    </SettingsGroup>
  );
}
