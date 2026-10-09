import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DesktopBridgeRequired } from "@/components/desktop-bridge-required";
import { ConnectionGate } from "@/features/connections/connection-gate";
import { loadPreferences } from "@/features/persistence/preference-storage";
import { applyTheme } from "@/lib/theme";
import { isWispBridgeAvailable } from "@/lib/wisp-bridge";
import "../styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Unable to find the React root element.");
}

// The screens shown before the app loads, such as connecting to a server, follow the saved theme too.
applyTheme(loadPreferences(window.localStorage).value.theme);

const exposedBridge = Reflect.get(window, "wisp") as unknown;

createRoot(rootElement).render(
  <StrictMode>
    {isWispBridgeAvailable(exposedBridge) ? (
      <ConnectionGate>
        <App />
      </ConnectionGate>
    ) : (
      <DesktopBridgeRequired />
    )}
  </StrictMode>,
);
