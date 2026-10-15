import { SettingsIcon } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";

import type { AppLink } from "../../shared/app-links";

/** Opens the screen an app link names. Without one, app links show as plain text. */
const AppLinkContext = createContext<((link: AppLink) => void) | null>(null);

export const AppLinkProvider = AppLinkContext.Provider;

/** A `wisp://` link in a reply: a button that opens the settings screen it names. */
export function AppLinkButton({ link, children }: { link: AppLink; children: ReactNode }) {
  const open = useContext(AppLinkContext);
  if (!open) return <span className="font-medium">{children}</span>;
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1 rounded-[5px] border-0 bg-blue/10 px-1.5 py-px align-baseline font-medium text-blue hover:bg-blue/15 [&_svg]:size-3"
      onClick={() => open(link)}
    >
      <SettingsIcon aria-hidden="true" />
      {children}
    </button>
  );
}
