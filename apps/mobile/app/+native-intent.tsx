// Expo Router convention file (final review I1/I2): intercepts every
// incoming path — cold start and warm start — before it becomes a route or
// route params. Screens stay thin (global-constraints.md): the actual
// decision is `redirectSystemPath` in src/lib/native-intent.ts, tested
// there without a React Native renderer.
import { redirectSystemPath as redirect } from "@/lib/native-intent";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return redirect(path);
}
