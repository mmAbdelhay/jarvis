// The device-owner check in front of the stored refresh token (Phase 0
// owner login): Face ID, fingerprint, or the device passcode as fallback,
// via expo-local-authentication. Thin and untested: auth-session.ts holds
// the gating logic and its tests use a double.

import * as LocalAuthentication from "expo-local-authentication";
import type { DeviceAuth } from "./auth-session";

export function createDeviceAuth(prompt: () => string): DeviceAuth {
  return {
    async hasPasscode() {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      return level !== LocalAuthentication.SecurityLevel.NONE;
    },
    async authenticate() {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: prompt(),
        disableDeviceFallback: false,
      });
      return result.success;
    },
  };
}
