// The one HTTP door for model providers. fetch is injected (tests use
// http-double.ts); a provider's error body is read for its message, capped,
// and scrubbed of the API key before it can reach a log, a push or the shell.
import { ProviderError, isRecord } from "@jarvis/core";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

const MAX_ERROR_CHARS = 300;

export function scrubKey(text: string, secret?: string): string {
  return secret === undefined || secret === "" ? text : text.replaceAll(secret, "[key]");
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const code = isRecord(cause) && typeof cause["code"] === "string" ? cause["code"] : undefined;
    if ((error as { name?: unknown }).name === "TimeoutError") return "timed out";
    return code === undefined ? error.message : `${error.message} (${code})`;
  }
  return String(error);
}

function errorMessage(body: string, secret?: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed["error"];
      if (typeof error === "string") return scrubKey(error, secret);
      if (isRecord(error) && typeof error["message"] === "string")
        return scrubKey(error["message"], secret);
      if (typeof parsed["message"] === "string") return scrubKey(parsed["message"], secret);
    }
  } catch {
    // Not JSON: the raw text below.
  }
  const trimmed = scrubKey(body, secret).trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 200);
}

export async function request(
  fetch: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  secret?: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    const host = new URL(url).host;
    throw new ProviderError(
      "network",
      scrubKey(`Cannot reach ${host}: ${describeError(error)}`, secret),
    );
  }
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  const message =
    `${response.status} ${errorMessage(body, secret) ?? scrubKey(response.statusText, secret)}`.slice(
      0,
      MAX_ERROR_CHARS,
    );
  const kind = response.status === 401 || response.status === 403 ? "auth" : "http";
  throw new ProviderError(kind, scrubKey(message, secret), response.status);
}

export async function readJson(response: Response, what: string): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderError("bad-response", `${what}: the answer was not JSON`);
  }
}
