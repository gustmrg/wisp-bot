import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Squirrel.Mac refuses to install updates unless the running bundle and the
// downloaded archive share a real Developer ID signature, so ad-hoc-signed or
// unsigned builds (the current release configuration) can only offer a manual
// download. Windows NSIS and AppImage install fine without signing.
export async function resolveAutoInstallSupport(
  platform: NodeJS.Platform,
  execPath: string,
  runCodesign: (bundlePath: string) => Promise<{ ok: boolean; output: string }> = defaultCodesignRunner,
): Promise<boolean> {
  if (platform !== "darwin") return true;
  // execPath sits at <bundle>/Contents/MacOS/<binary>; codesign wants the bundle root.
  const bundlePath = path.resolve(execPath, "..", "..", "..");
  let result: { ok: boolean; output: string };
  try {
    result = await runCodesign(bundlePath);
  } catch {
    return false;
  }
  if (!result.ok) return false;
  return !/TeamIdentifier=not set|Signature=adhoc/.test(result.output);
}

async function defaultCodesignRunner(bundlePath: string): Promise<{ ok: boolean; output: string }> {
  // `codesign -dv` prints its report on stderr and exits non-zero when the
  // bundle has no signature at all.
  try {
    const { stderr } = await execFileAsync("codesign", ["-dv", bundlePath]);
    return { ok: true, output: stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (typeof failure.code === "number" && typeof failure.stderr === "string") {
      return { ok: false, output: failure.stderr };
    }
    throw error;
  }
}
