import type { CurrentUser } from "../../../shared/current-user";
import type { RemoteOwner } from "../../../shared/remote-protocol";
export function remoteOwner(owner: RemoteOwner): CurrentUser {
  const name = owner.name.trim() || "Owner";
  const words = name.split(/\s+/);
  return {
    displayName: name,
    givenName: words[0] ?? name,
    initials: words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase(),
    email: "",
  };
}
