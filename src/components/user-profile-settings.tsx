import { useState } from "react";
import { normalizeUserProfile, PROFILE_LIMITS } from "../../shared/user-profile";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { SettingsCard, SettingsGroup } from "@/components/settings/settings-primitives";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export function UserProfileSettings({ controller }: { controller: UserProfileController }) {
  const [draft, setDraft] = useState(controller.profile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(controller.profile);
  return (
    <SettingsGroup label="Your profile">
      <SettingsCard>
        <form
          className="flex flex-col gap-4 p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            const success = await controller.save(draft);
            if (success) setDraft(normalizeUserProfile(draft));
            setSaved(success);
            setSaving(false);
          }}
        >
          <p className="text-xs text-dim">
            Saved on this device. Shared with your Wisps to personalize responses, including with their AI provider when
            you chat.
          </p>
          <fieldset disabled={saving || controller.loading} className="flex min-w-0 flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm" htmlFor="profile-name">
              Preferred name
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
            </label>
            <label className="flex flex-col gap-2 text-sm" htmlFor="profile-about">
              About you (optional)
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
            </label>
            <label className="flex flex-col gap-2 text-sm" htmlFor="profile-responses">
              Response preferences (optional)
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
            </label>
            <div>
              <Button type="submit" size="sm" disabled={!dirty}>
                {saving ? "Saving…" : "Save profile"}
              </Button>
            </div>
          </fieldset>
          {controller.error ? (
            <p role="alert" className="text-sm text-destructive">
              {controller.error}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="text-xs text-dim">
              Profile saved.
            </p>
          ) : null}
        </form>
      </SettingsCard>
    </SettingsGroup>
  );
}
