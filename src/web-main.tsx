import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RemoteShell } from "@/features/auth/remote-shell";
import "../styles.css";
import "@/features/backend/platform.css";

const root = document.getElementById("root");
if (!root) throw new Error("Unable to find the application root.");
createRoot(root).render(
  <StrictMode>
    <RemoteShell mobile={__WISP_MOBILE__} />
  </StrictMode>,
);
if (!__WISP_MOBILE__ && import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    },
    { once: true },
  );
}
