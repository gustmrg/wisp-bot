import { useState } from "react";
import { PROFILE_LIMITS } from "../../shared/user-profile";
import type { UserProfileController } from "@/hooks/use-user-profile";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";

/** The person's name, saved when the field loses focus like the other settings on the page. */
export function UserProfileSettings({ controller }: { controller: UserProfileController }) {
  const saved = controller.profile.preferredName;
  const [name, setName] = useState(saved);
  const [saving, setSaving] = useState(false);
  const nameMissing = !name.trim();

  async function commit(): Promise<void> {
    if (nameMissing || name.trim() === saved) return;
    setSaving(true);
    if (await controller.save({ ...controller.profile, preferredName: name })) setName(name.trim());
    setSaving(false);
  }

  return (
    <SettingsGroup label="You">
      <SettingsCard>
        <SettingsRow className="max-[620px]:flex-col max-[620px]:items-stretch">
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="profile-name">Name</SettingsRowTitle>
            <SettingsRowDescription>
              What your Wisps call you. They also send it to their AI provider when you chat.
            </SettingsRowDescription>
          </SettingsRowCopy>
          <Input
            id="profile-name"
            autoComplete="given-name"
            maxLength={PROFILE_LIMITS.preferredName}
            value={name}
            placeholder="Your name"
            disabled={saving || controller.loading}
            aria-invalid={nameMissing || undefined}
            className="w-56 shrink-0 max-[620px]:w-full"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </SettingsRow>
      </SettingsCard>
      <FormStatus
        className="mx-0.5 mt-1.5"
        error={nameMissing ? "Your name is required." : (controller.error ?? undefined)}
        pending={saving ? "Saving…" : undefined}
      />
    </SettingsGroup>
  );
}
