import type { UpdateCheck } from "../src/update-check.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { PERSONAL_PROJECT } from "../src/personal.js";

// Settings → General's Check for updates. Nothing here runs until the
// button is pressed: the check is one request to GitHub, and Jarvis makes
// no network request the user did not ask for (update-check.ts).

function describe(result: UpdateCheck): string {
  if (result.kind === "newer") {
    return MESSAGES.updateNewer(result.latest, result.current, PRIMARY_LANGUAGE);
  }
  if (result.kind === "current") return MESSAGES.updateCurrent(result.current, PRIMARY_LANGUAGE);
  return MESSAGES.updateFailed(PRIMARY_LANGUAGE);
}

export function initUpdateSettings(): void {
  const check = document.getElementById("settings-update-check");
  const result = document.getElementById("settings-update-result");
  const open = document.getElementById("settings-update-open");
  if (!(check instanceof HTMLButtonElement) || result === null || open === null) return;
  check.textContent = MESSAGES.updateCheck(PRIMARY_LANGUAGE);
  open.textContent = MESSAGES.updateOpen(PRIMARY_LANGUAGE);
  let releaseUrl: string | undefined;

  check.addEventListener("click", () => {
    check.disabled = true;
    open.hidden = true;
    result.textContent = MESSAGES.updateChecking(PRIMARY_LANGUAGE);
    void window.jarvis
      .checkForUpdate()
      .then((answer) => {
        result.textContent = describe(answer);
        releaseUrl = answer.kind === "newer" ? answer.url : undefined;
        open.hidden = releaseUrl === undefined;
      })
      .catch(() => {
        result.textContent = MESSAGES.updateFailed(PRIMARY_LANGUAGE);
      })
      .finally(() => {
        check.disabled = false;
      });
  });

  // In the Personal browser, which belongs to no project — a download page
  // is not project work.
  open.addEventListener("click", () => {
    if (releaseUrl !== undefined) void window.jarvis.openTab(PERSONAL_PROJECT, releaseUrl);
  });
}
