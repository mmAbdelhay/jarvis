import type { CommandRunner } from "@jarvis/core";

export type Transcript = { text: string; language: string };
export type WhisperConfig = { binaryPath: string; modelPath: string };

const LANGUAGE_PATTERN = /auto-detected language:\s*([a-z]{2})/i;

export function parseWhisperOutput(stdout: string, stderr: string): Transcript {
  const text = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");

  const match = LANGUAGE_PATTERN.exec(stderr);
  return { text, language: match?.[1]?.toLowerCase() ?? "en" };
}

export async function transcribe(
  wavPath: string,
  config: WhisperConfig,
  run: CommandRunner,
): Promise<Transcript> {
  const { stdout, stderr } = await run(config.binaryPath, [
    "-m", config.modelPath,
    "-l", "auto",
    "-nt",
    "-f", wavPath,
  ]);
  return parseWhisperOutput(stdout, stderr);
}
