// The browser build's `DeviceAuth` (Task 13), pure. A browser has no OS
// device-owner prompt, so the gate auth-session.ts puts in front of the
// stored refresh token becomes the owner's own choice:
// - `hasPasscode()` answers "Keep me signed in on this browser" (default
//   off). Off means auth-session never stores a refresh token and deletes
//   any it finds, so leaked browser storage holds no usable token.
// - `authenticate()` always passes: with the setting on, a stored token
//   goes straight to `auth:refresh` (the laptop's 7-day idle expiry still
//   applies there).
import type { DeviceAuth } from "./auth-session";

export function createWebDeviceAuth(keepSignedIn: () => Promise<boolean>): DeviceAuth {
  return {
    async hasPasscode() {
      try {
        return (await keepSignedIn()) === true;
      } catch {
        return false;
      }
    },
    async authenticate() {
      return true;
    },
  };
}
