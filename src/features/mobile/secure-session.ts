import { Capacitor, registerPlugin } from "@capacitor/core";
import type { DeviceCredentials } from "../../../shared/remote-protocol";
import { validateRemoteEndpoint } from "../../../client/remote-backend-client";

interface SecureSessionPlugin {
  read(): Promise<{ value: string | null }>;
  write(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
}
const vault = registerPlugin<SecureSessionPlugin>("WispSecureSession");
export interface SavedMobileSession {
  endpoint: string;
  credentials: DeviceCredentials;
}
export async function readMobileSession(): Promise<SavedMobileSession | undefined> {
  if (!Capacitor.isNativePlatform()) throw new Error("Open the installed mobile app to use protected device storage.");
  const result = await vault.read();
  if (!result.value) return undefined;
  const value: unknown = JSON.parse(result.value);
  if (
    !value ||
    typeof value !== "object" ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string" ||
    !("credentials" in value) ||
    !value.credentials ||
    typeof value.credentials !== "object"
  )
    throw new Error("The saved mobile session is invalid. Sign out and pair again.");
  const credentials = value.credentials as Partial<DeviceCredentials>;
  if (
    [
      credentials.accessToken,
      credentials.refreshToken,
      credentials.deviceId,
      credentials.serverId,
      credentials.expiresAt,
    ].some((item) => typeof item !== "string" || !item)
  )
    throw new Error("The saved mobile session is invalid. Sign out and pair again.");
  return { endpoint: validateRemoteEndpoint(value.endpoint), credentials: credentials as DeviceCredentials };
}
export async function saveMobileSession(endpoint: string, credentials: DeviceCredentials | undefined): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error("Protected device storage is unavailable.");
  if (credentials)
    await vault.write({ value: JSON.stringify({ endpoint: validateRemoteEndpoint(endpoint), credentials }) });
  else await vault.clear();
}
