export type AgentMode = "pi" | "fake";

export function selectAgentMode(isPackaged: boolean, environmentMode: string | undefined): AgentMode {
  return !isPackaged && environmentMode === "fake" ? "fake" : "pi";
}
