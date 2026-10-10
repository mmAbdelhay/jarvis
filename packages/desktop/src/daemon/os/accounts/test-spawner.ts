import type { CliInvocation, CliProcess, CliPurpose, CliSpawner } from "@jarvis/platform/model";

export type Scripted = { exitCode: number | null; lines?: string[]; hang?: boolean };

export function scriptedSpawner(
  script: Partial<Record<CliPurpose, Scripted>>,
  seen: CliInvocation[] = [],
  killed: CliInvocation[] = [],
): CliSpawner {
  return async (inv): Promise<CliProcess> => {
    seen.push(inv);
    const step = script[inv.purpose] ?? { exitCode: 0 };
    let release: (code: number | null) => void = () => {};
    const exit =
      step.hang === true
        ? new Promise<number | null>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(step.exitCode);
    return {
      lines: (async function* () {
        yield* step.lines ?? [];
        if (step.hang === true) await exit;
      })(),
      exit,
      stderrTail: () => "",
      kill: async () => {
        killed.push(inv);
        release(null);
      },
    };
  };
}
