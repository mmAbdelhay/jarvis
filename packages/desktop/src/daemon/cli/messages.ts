// The jarvisd CLI's own strings, bilingual like every user-visible string
// (docs/develop/conventions.md): language in, string out. Anything Settings
// already says (owner password errors, web state, problems, pairing and
// device labels) is taken from MESSAGES in ../../messages.ts instead of
// being restated here; this table holds only what a terminal needs and a
// window does not.
//
// The CLI renders them in PRIMARY_LANGUAGE (English by the user's own
// instruction), the same fallback the app's chrome uses.
//
// No electron here (core/no-electron.test.ts).
import type { UsageProblem } from "./args.js";

type Language = "ar" | "en";

const USAGE: Record<Language, string> = {
  en: `Usage: jarvisd <command>

  run                 Run the Jarvis daemon in the foreground.
  status              Show whether the daemon runs, and the remote access state.
  set-password        Set or change the owner password (asks without echo).
    --stdin           Read it from standard input instead: one line, or two
                      (current, then new) when a password is already set.
  pair                Open pairing, show the link and QR, approve the device.
  devices             List paired devices.
  revoke <id>         Unpair a device.
  sign-out-all        Sign every phone and browser out.
    --yes             Do not ask for confirmation.
  web on|off          Turn browser access on or off.
  stop                Stop the daemon.
  --help              Show this help.

Exit codes: 0 done, 1 failed, 2 usage error, 3 the daemon is not running
(for run: another daemon already is).
`,
  ar: `الاستخدام: jarvisd <أمر>

  run                 شغّل خدمة Jarvis في الواجهة.
  status              اعرض حالة الخدمة وحالة الوصول عن بُعد.
  set-password        عيّن كلمة مرور المالك أو غيّرها (دون إظهارها).
    --stdin           اقرأها من الإدخال القياسي: سطر واحد، أو سطران
                      (الحالية ثم الجديدة) إن كانت هناك كلمة مرور.
  pair                افتح الإقران واعرض الرابط والرمز ووافق على الجهاز.
  devices             اعرض الأجهزة المقترنة.
  revoke <id>         ألغِ إقران جهاز.
  sign-out-all        سجّل خروج كل الهواتف والمتصفحات.
    --yes             دون طلب تأكيد.
  web on|off          شغّل الوصول من المتصفح أو أوقفه.
  stop                أوقف الخدمة.
  --help              اعرض هذه المساعدة.

رموز الخروج: 0 تم، 1 فشل، 2 خطأ في الاستخدام، 3 الخدمة لا تعمل
(مع run: هناك خدمة أخرى تعمل بالفعل).
`,
};

function pick(language: Language, ar: string, en: string): string {
  return language === "ar" ? ar : en;
}

export const CLI_MESSAGES = {
  usage: (language: Language): string => USAGE[language],
  usageError: (problem: UsageProblem, language: Language): string => {
    switch (problem.code) {
      case "missing-command":
        return pick(language, "لم يُحدَّد أمر.", "No command given.");
      case "unknown-command":
        return pick(
          language,
          `أمر غير معروف: ${problem.value}`,
          `Unknown command: ${problem.value}`,
        );
      case "unknown-option":
        return pick(
          language,
          `خيار غير معروف: ${problem.value}`,
          `Unknown option: ${problem.value}`,
        );
      case "unexpected-argument":
        return pick(
          language,
          `وسيط غير متوقع: ${problem.value}`,
          `Unexpected argument: ${problem.value}`,
        );
      case "missing-argument":
        return pick(
          language,
          `ينقص الأمر ${problem.value} وسيط.`,
          `${problem.value} needs an argument.`,
        );
      case "bad-web-value":
        return pick(
          language,
          `يقبل web القيمة on أو off فقط، لا ${problem.value}.`,
          `web takes on or off, not ${problem.value}.`,
        );
    }
  },
  notRunning: (language: Language): string =>
    pick(language, "خدمة Jarvis لا تعمل.", "The Jarvis daemon is not running."),
  restartRequired: (language: Language): string =>
    pick(
      language,
      "تعمل خدمة Jarvis بإصدار آخر. أعد تشغيلها ثم حاول مجددًا.",
      "The Jarvis daemon runs a different build. Restart it, then try again.",
    ),
  failed: (detail: string, language: Language): string =>
    pick(language, `فشل الطلب: ${detail}`, `The request failed: ${detail}`),
  connectionLost: (language: Language): string =>
    pick(language, "انقطع الاتصال بخدمة Jarvis.", "The connection to the Jarvis daemon was lost."),
  cancelled: (language: Language): string => pick(language, "أُلغي.", "Cancelled."),
  needsTerminal: (language: Language): string =>
    pick(
      language,
      "يحتاج set-password إلى طرفية ليسأل عن كلمة المرور. استخدم --stdin لتمريرها من برنامج.",
      "set-password needs a terminal to ask for the password. Use --stdin to pass it from a script.",
    ),
  noPasswordOnStdin: (language: Language): string =>
    pick(
      language,
      "لم تصل كلمة المرور على الإدخال القياسي.",
      "No password arrived on standard input.",
    ),
  daemonRunning: (language: Language): string =>
    pick(language, "خدمة Jarvis: تعمل", "Jarvis daemon: running"),
  // `label: value` rows of `jarvisd status`.
  statusLabel: (
    row: "remote" | "listening" | "problem" | "owner" | "passkeys" | "web" | "devices" | "pairing",
    language: Language,
  ): string => {
    const text = {
      remote: { ar: "الوصول عن بُعد", en: "Remote access" },
      listening: { ar: "يستمع على", en: "Listening on" },
      problem: { ar: "مشكلة", en: "Problem" },
      owner: { ar: "حساب المالك", en: "Owner account" },
      passkeys: { ar: "مفاتيح المرور", en: "Passkeys" },
      web: { ar: "الوصول من المتصفح", en: "Browser access" },
      devices: { ar: "الأجهزة المقترنة", en: "Paired devices" },
      pairing: { ar: "الإقران", en: "Pairing" },
    };
    return text[row][language];
  },
  devicesCount: (total: number, connected: number, language: Language): string =>
    pick(language, `${total} (المتصل الآن: ${connected})`, `${total} (${connected} connected)`),
  pairingState: (state: "closed" | "open" | "confirming", language: Language): string => {
    const text = {
      closed: { ar: "مغلق", en: "closed" },
      open: { ar: "مفتوح", en: "open" },
      confirming: { ar: "بانتظار التأكيد", en: "waiting for confirmation" },
    };
    return text[state][language];
  },
  // Column headings of `jarvisd devices`.
  deviceColumn: (
    column: "id" | "name" | "client" | "state" | "paired" | "lastSeen",
    language: Language,
  ): string => {
    const text = {
      id: { ar: "المعرّف", en: "ID" },
      name: { ar: "الاسم", en: "NAME" },
      client: { ar: "العميل", en: "CLIENT" },
      state: { ar: "الحالة", en: "STATE" },
      paired: { ar: "أُقرن في", en: "PAIRED" },
      lastSeen: { ar: "آخر ظهور", en: "LAST SEEN" },
    };
    return text[column][language];
  },
  deviceIdle: (language: Language): string => pick(language, "غير متصل", "offline"),
  never: (language: Language): string => pick(language, "أبدًا", "never"),
  pairNeedsTerminal: (language: Language): string =>
    pick(
      language,
      "يحتاج pair إلى طرفية: رابط الإقران ورمزه يحملان سرّ الإقران، فلا يُطبعان في ملف أو أنبوب.",
      "pair needs a terminal: the pairing link and QR carry the pairing secret, so they are never printed into a file or a pipe.",
    ),
  pairRequestGone: (language: Language): string =>
    pick(
      language,
      "انتهى طلب الإقران قبل وصول ردّك، فلم يُطبَّق شيء.",
      "The pairing request ended before your answer reached it; nothing was applied.",
    ),
  pairAppLink: (language: Language): string =>
    pick(language, "رابط تطبيق الهاتف:", "Phone app link:"),
  pairWebLink: (language: Language): string => pick(language, "رابط المتصفح:", "Browser link:"),
  pairWaiting: (language: Language): string =>
    pick(
      language,
      "بانتظار طلب إقران… (Ctrl-C للإلغاء)",
      "Waiting for a pairing request… (Ctrl-C to cancel)",
    ),
  pairApprovePrompt: (language: Language): string =>
    pick(language, "هل توافق؟ [y/N] ", "Approve? [y/N] "),
  pairApproved: (language: Language): string =>
    pick(
      language,
      "تمت الموافقة. يكمل الجهاز الإقران الآن.",
      "Approved. The device finishes pairing now.",
    ),
  pairDeclined: (language: Language): string => pick(language, "رُفض الطلب.", "Declined."),
  pairClosed: (language: Language): string =>
    pick(
      language,
      "أُغلقت نافذة الإقران قبل وصول طلب.",
      "The pairing window closed before a request arrived.",
    ),
  revoked: (language: Language): string => pick(language, "أُلغي إقران الجهاز.", "Device revoked."),
  signOutPrompt: (language: Language): string =>
    pick(language, "هل تريد المتابعة؟ [y/N] ", "Continue? [y/N] "),
  webSaved: (enabled: boolean, language: Language): string =>
    enabled
      ? pick(language, "شُغّل الوصول من المتصفح.", "Browser access turned on.")
      : pick(language, "أُوقف الوصول من المتصفح.", "Browser access turned off."),
  stopping: (language: Language): string =>
    pick(language, "جارٍ إيقاف خدمة Jarvis…", "Stopping the Jarvis daemon…"),
  stopped: (language: Language): string => pick(language, "توقفت.", "Stopped."),
  stillRunning: (language: Language): string =>
    pick(
      language,
      "طُلب الإيقاف، لكن الخدمة ما زالت تعمل بعد 15 ثانية.",
      "The stop was requested, but the daemon still runs after 15 seconds.",
    ),
};
