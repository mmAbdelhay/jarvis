import { t, type Language, type MessageKey } from "../lib/i18n";
import type { PlanErrorCode } from "../lib/plans-store";

const ERROR_KEYS: Record<PlanErrorCode, MessageKey> = {
  loadFailed: "plans.loadFailed",
  sendFailed: "plans.error.sendFailed",
  saveFailed: "plans.error.saveFailed",
  conflict: "plans.error.conflict",
  tooLarge: "plans.error.tooLarge",
  forbidden: "plans.error.forbidden",
  noPane: "plans.error.noPane",
  noComments: "plans.error.noComments",
};

export function planErrorText(language: Language, code: PlanErrorCode): string {
  return t(language, ERROR_KEYS[code]);
}
