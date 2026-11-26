/**
 * What the workspace keeps when it remounts for another environment or a
 * reconnect: the window is still open, so it should look as it did. Kept
 * outside React, like composer drafts.
 */
interface WorkspaceMemory {
  /** The window has opened a workspace once, so later remounts skip the opening checks and splash. */
  opened: boolean;
  sidebarFilter: "all" | "unread" | "active";
  sidebarScrollTop: number;
}

const INITIAL: WorkspaceMemory = { opened: false, sidebarFilter: "all", sidebarScrollTop: 0 };

let memory: WorkspaceMemory = { ...INITIAL };

export function workspaceMemory(): Readonly<WorkspaceMemory> {
  return memory;
}

export function rememberWorkspace(changes: Partial<WorkspaceMemory>): void {
  memory = { ...memory, ...changes };
}

export function clearWorkspaceMemory(): void {
  memory = { ...INITIAL };
}
