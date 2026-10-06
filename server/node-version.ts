/**
 * Imported first by the command line and the server, so an old Node.js says
 * what to do instead of failing on a module it lacks (`node:sqlite`).
 */
export const MINIMUM_NODE = [22, 19, 0] as const;

export function isSupportedNode(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < MINIMUM_NODE.length; index++) {
    const have = parts[index] ?? 0;
    const need = MINIMUM_NODE[index]!;
    if (have !== need) return have > need;
  }
  return true;
}

// Node.js 22 calls `node:sqlite` experimental on every start. That line would
// clutter the journal and show up as setup progress in the desktop app; other
// warnings still print.
const printWarning = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)) return;
  for (const listener of printWarning) listener(warning);
});

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(
    `Wisp needs Node.js ${MINIMUM_NODE.join(".")} or later; this is ${process.versions.node}. Install a newer Node.js and run the command again.\n`,
  );
  process.exit(1);
}
