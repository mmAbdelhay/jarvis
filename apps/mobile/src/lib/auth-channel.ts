// Native: one app instance, no other tabs to tell (auth-channel.web.ts has
// the browser's).
import type { AuthChannel } from "./auth-session";

export const authChannel: AuthChannel | undefined = undefined;
