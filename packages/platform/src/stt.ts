import type { CommandRunner } from "@jarvis/core";

export type Transcript = { text: string; language: string };
export type WhisperConfig = { binaryPath: string; modelPath: string };

const LANGUAGE_PATTERN = /auto-detected language:\s*([a-z]{2,3})/i;

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
  const { code, stdout, stderr } = await run(config.binaryPath, [
    "-m", config.modelPath,
    "-l", "auto",
    "-nt",
    "-f", wavPath,
  ]);

  // A non-zero exit (bad model path, corrupt wav) can produce empty
  // stdout with no error message, which looks exactly like a silent
  // recording. Throw so the caller can tell "transcription is broken"
  // apart from "the user said nothing".
  if (code !== 0) {
    throw new Error(`whisper-cli exited with code ${code}: ${stderr.trim()}`);
  }

  return parseWhisperOutput(stdout, stderr);
}
