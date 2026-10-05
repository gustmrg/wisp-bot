import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DesktopBridgeRequired } from "@/components/desktop-bridge-required";
import { ConnectionGate } from "@/features/connections/connection-gate";
import { isWispBridgeAvailable } from "@/lib/wisp-bridge";
import "../styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Unable to find the React root element.");
}

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
