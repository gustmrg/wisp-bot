import { safeStorage } from "electron";

import type { EncryptionService } from "../../backend/encrypted-credential-store.js";

export class SafeStorageEncryption implements EncryptionService {
  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
  }

  encrypt(value: string): Buffer {
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    return safeStorage.decryptString(value);
  }
}
