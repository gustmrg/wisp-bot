import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}
