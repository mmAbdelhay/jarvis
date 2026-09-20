// Important 9: main.ts previously invented its own English-only lane of
// user-facing strings beside @jarvis/core's bilingual MESSAGES table
// (orchestrator.ts). The user's primary language is Arabic, so every
// string a person can actually see or hear must follow the same
// language-in, string-out pattern core already uses — not duplicate an
// English-only one.
//
// None of these events carry a language signal of their own (a hotkey
// collision is discovered at startup, before any utterance; a broken
// recording or transcription pipeline means no language was ever
// detected), so callers pass the user's configured primary language.
// The user's primary language, shared by both the main process (which
// picks it for strings fired before any utterance is heard, or after the
// language signal itself is lost) and the renderer (which cannot import
// main.ts — that would pull Electron into a browser-side bundle). This is
// the one definition both sides read; do not duplicate it.
//
// English by the user's own instruction ("make all default at english
// layout"). This is only the FALLBACK: it decides the chrome and any
// string fired before a language signal exists. It never overrides a
// detected utterance — an Arabic sentence still gets an Arabic reply, and
// Arabic session/project text still renders RTL via detectLanguage().
import type { PrerequisiteId } from "@jarvis/platform";
import type { BindKind, RemoteErrorCode, RemoteProblem } from "@jarvis/remote";
import type { PushKind } from "@jarvis/wire";

export const PRIMARY_LANGUAGE = "en";

// A literal token, never derived from the name being inserted — see the
// comment above remotePairWaiting for why splitting on the *template*
// rather than on the substituted string matters.
const NAME_PLACEHOLDER = "{name}";

const REMOTE_PAIR_WAITING_TEMPLATE: Record<"ar" | "en", string> = {
  en: `Waiting for you to confirm ${NAME_PLACEHOLDER}…`,
  ar: `بانتظار تأكيدك لجهاز «${NAME_PLACEHOLDER}»…`,
};

const REMOTE_CONFIRM_BODY_TEMPLATE: Record<"ar" | "en", string> = {
  en: `${NAME_PLACEHOLDER} is asking to pair with this machine. Once approved, it can run commands as you.`,
  ar: `يطلب الجهاز ${NAME_PLACEHOLDER} الاقتران بهذا الحاسوب. بعد الموافقة سيتمكن من تشغيل أوامر باسمك.`,
};

function splitOnNamePlaceholder(template: string): { before: string; after: string } {
  const index = template.indexOf(NAME_PLACEHOLDER);
  if (index === -1) return { before: template, after: "" };
  return {
    before: template.slice(0, index),
    after: template.slice(index + NAME_PLACEHOLDER.length),
  };
}

export const MESSAGES = {
  hotkeyCollision: (combo: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر تسجيل اختصار ${combo} — يبدو أن تطبيقًا آخر يستخدمه بالفعل.`
      : `Could not register the ${combo} shortcut — another app is probably already using it.`,
  // Nothing is installed that can speak at all. Distinct from the Arabic-only
  // case below: telling someone their Arabic voice is missing when no voice
  // of any kind is installed sends them to fix the wrong thing.
  noVoiceInstalled: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا يوجد صوت مثبَّت — ثبِّت Piper وحمِّل نموذجًا، أو أوقف النطق من الإعدادات."
      : "No voice is installed — install Piper and download a model, or turn speech off in Settings.",
  // Linux has no `say`, so an Arabic reply needs an Arabic Piper model. The
  // reply is already on screen; only the audio is missing, and the user is
  // told which key would fix it rather than left with a voice that answers in
  // one language and not the other.
  arabicVoiceUnavailable: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا يوجد صوت عربي مثبَّت — حمِّل نموذج Piper عربيًا وحدِّد مساره في voice.piperArabicModel."
      : "No Arabic voice is installed — download an Arabic Piper model and set voice.piperArabicModel.",
  // A different cause from hotkeyCollision, and different advice. Wayland
  // gives no application a way to grab a key system-wide at all, so telling a
  // Wayland user to look for a conflicting app sends them hunting for
  // something that does not exist.
  hotkeyUnavailableWayland: (combo: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `اختصار ${combo} لا يعمل على Wayland — استخدم زر الميكروفون، أو اربط الاختصار من إعدادات لوحة المفاتيح في سطح المكتب.`
      : `The ${combo} shortcut does not work on Wayland — use the microphone button, or bind it in your desktop's own keyboard settings.`,
  // The first-run prerequisites screen.
  //
  // Each tool gets a name and one line saying what it unlocks, because "what
  // is dbgate-serve" is the question a first-run screen exists to answer. The
  // wording lives here rather than in the catalogue so both languages stay
  // together, and prerequisites.test.ts asserts that every id has both.
  prerequisiteName: (id: PrerequisiteId, language: "ar" | "en"): string =>
    PREREQUISITE_TEXT[id][language].name,
  prerequisiteUnlocks: (id: PrerequisiteId, language: "ar" | "en"): string =>
    PREREQUISITE_TEXT[id][language].unlocks,
  setupTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "جارفيس يحتاج بعض الأدوات" : "Jarvis needs a few tools",
  setupIntro: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لن يُثبَّت شيء حتى تختار. ما يحتاج صلاحيات الجذر يُعرض كأمر تنسخه بنفسك."
      : "Nothing is installed until you choose. Anything needing root is shown as a command to copy.",
  setupRequired: (language: "ar" | "en"): string => (language === "ar" ? "مطلوب" : "Required"),
  setupOptional: (language: "ar" | "en"): string => (language === "ar" ? "اختياري" : "Optional"),
  setupInstalled: (language: "ar" | "en"): string => (language === "ar" ? "مثبَّت" : "Installed"),
  setupUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "غير متاح على هذا النظام" : "Not available on this platform",
  // Two different things end up in this slot: a command for a package
  // manager, and a page for a tool that has no package. Labelling a URL "run
  // this in a terminal" is wrong, and wrong instructions are how a reader
  // learns to stop reading them.
  setupCopyHint: (language: "ar" | "en"): string =>
    language === "ar" ? "شغِّل هذا في الطرفية" : "Run this in a terminal",
  setupOpenHint: (language: "ar" | "en"): string =>
    language === "ar" ? "افتح هذه الصفحة" : "Open this page",
  setupInstallCount: (count: number, language: "ar" | "en"): string =>
    language === "ar" ? `ثبِّت ${arabicToolsCount(count)}` : `Install ${count} selected`,
  setupInstalling: (language: "ar" | "en"): string =>
    language === "ar" ? "جارٍ التثبيت…" : "Installing…",
  setupSkip: (language: "ar" | "en"): string => (language === "ar" ? "تخطَّ" : "Skip"),
  setupDone: (language: "ar" | "en"): string => (language === "ar" ? "تم" : "Done"),
  setupFailed: (id: PrerequisiteId, detail: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذّر تثبيت ${PREREQUISITE_TEXT[id].ar.name}: ${detail}`
      : `Could not install ${PREREQUISITE_TEXT[id].en.name}: ${detail}`,
  setupVoiceSize: (language: "ar" | "en"): string =>
    language === "ar" ? "نحو ٦١ ميجابايت للتنزيل" : "about 61 MB to download",
  /** Windows only: the primary pair was taken and a second one is live. */
  hotkeyFallback: (combo: string, replacement: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `اختصار ${combo} يستخدمه تطبيق آخر، لذا سيعمل ${replacement} بدلًا منه.`
      : `The ${combo} shortcut is taken by another app, so ${replacement} works instead.`,
  recordingFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar" ? `تعذر تسجيل الصوت: ${message}` : `Recording failed: ${message}`,
  // M12 Task 7 (ruling 10, "voice leak"): `turn:new` reaches every
  // subscribed client, remote-paired phones included, so this no longer
  // carries a detail argument — a desktop-origin transcription failure's
  // own message (a wav path, a dependency's stderr) belongs only in the
  // laptop's own log line (voice-turn.ts's `log`), never in a broadcast
  // payload. Previously `transcriptionFailed(message, language)`.
  transcriptionFailed: (language: "ar" | "en"): string =>
    language === "ar" ? "فشل تحويل الصوت إلى نص." : "Transcription failed.",
  // Moved verbatim from main.ts's inline strings — the "recorded but heard
  // nothing" notice, distinct from transcriptionFailed (a broken pipeline)
  // above.
  nothingHeard: (language: "ar" | "en"): string =>
    language === "ar" ? "لم يُسمع شيء" : "Didn't catch that",
  // Ruling 17: generic, on purpose. A phone gets no filesystem path or
  // whisper/ffmpeg detail — that goes to the laptop console only
  // (voice-turn.ts's `log`). The desktop's own transcriptionFailed above,
  // which does carry the detail, is unchanged for desktop origin.
  voiceTurnFailed: (language: "ar" | "en"): string =>
    language === "ar"
      ? "تعذر فهم التسجيل على الحاسوب — حاول مرة أخرى."
      : "Couldn't understand the recording on the laptop — try again.",
  // remote:uploadAudio's own rejections (voice-upload.ts): a blob header
  // whose meta or bytes fail validation, before any temp dir or memory
  // entry is ever created.
  voiceUploadInvalid: (language: "ar" | "en"): string =>
    language === "ar" ? "تسجيل غير صالح." : "Invalid recording.",
  // One pending voice turn per device (ruling 9) — this is what the second,
  // still-in-flight upload or Retry gets back.
  voiceUploadBusy: (language: "ar" | "en"): string =>
    language === "ar"
      ? "جارٍ معالجة تسجيل سابق — انتظر قليلًا."
      : "Still working on an earlier recording — wait a moment.",
  // remote:uploadFile's own rejections (file-upload.ts): a blob header whose
  // meta or bytes fail validation, before any disk write or quota
  // reservation is ever made.
  fileUploadInvalid: (language: "ar" | "en"): string =>
    language === "ar" ? "ملف غير صالح." : "Invalid file.",
  // MAX_DEVICE_UPLOAD_BYTES / MAX_DEVICE_UPLOAD_FILES (file-upload.ts) — this
  // device already holds as much staged as it is allowed to at once.
  fileUploadQuotaExceeded: (language: "ar" | "en"): string =>
    language === "ar"
      ? "بلغ هذا الجهاز الحد الأقصى للملفات المؤقتة."
      : "This device already has the maximum amount staged.",
  // A disk-level failure staging the upload (never the dependency's own
  // message or a path — same discipline as voiceTurnFailed).
  fileUploadFailed: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر حفظ الملف." : "Could not stage the file.",
  // resolve()/readJson()'s one shared failure for every reason a staged
  // file cannot be read back: unknown, expired, owned by another device, or
  // swapped for a symlink since it was written — deliberately
  // indistinguishable to the phone (file-upload.ts).
  fileUploadNotFound: (language: "ar" | "en"): string =>
    language === "ar" ? "لم يُعثر على الملف، أو انتهت صلاحيته." : "File not found, or it expired.",
  // Shared by remote:readJsonUpload's decode (malformed JSON, over
  // MAX_JSON_UPLOAD_BYTES, or past validateRemoteImport's depth/node/key
  // bounds) and a remote api:importPostman call that fails the same bounds
  // or MAX_IMPORT_REQUESTS once converted — one sentence for what is, to the
  // person reading it, the same fact either way.
  remoteImportRejected: (language: "ar" | "en"): string =>
    language === "ar"
      ? "هذا الملف كبير جدًا أو غير صالح للاستيراد."
      : "This file is too large or not valid to import.",
  // Task 4: prepareRemoteApiRequest's one shared rejection for every reason
  // a remote api:send/api:save call cannot run as sent — too large, an
  // unsupported auth mode (oauth2 above all), a collection over its row
  // cap, or a multipart file value that is not a clean upload-id reference
  // — deliberately indistinguishable to the phone, same discipline as
  // remoteImportRejected and fileUploadNotFound above.
  remoteApiRejected: (language: "ar" | "en"): string =>
    language === "ar"
      ? "هذا الطلب لا يمكن تنفيذه من جهاز عن بُعد."
      : "This request cannot run from a remote device.",
  remoteApiResponseTooLarge: (language: "ar" | "en"): string =>
    language === "ar" ? "استجابة الخادم كبيرة جدًا." : "The server response is too large.",
  // M12 Task 12 minor: the runner's own kind: "timeout" (http-runner.ts) —
  // the request never got a response within the configured timeout — for a
  // remote call, same discipline as remoteApiResponseTooLarge above: this
  // sentence, never the runner's raw abort text.
  remoteApiTimedOut: (language: "ar" | "en"): string =>
    language === "ar" ? "انتهت مهلة الطلب." : "The request timed out.",
  // The renderer's history-panel badge (`${n} sessions`) — pulled through
  // here rather than left as an inline English template literal both for
  // the language-in/string-out pattern above and because English's
  // one/many split ("1 session" vs "2 sessions") doesn't carry over to
  // Arabic: MSA counted nouns have distinct singular (1), dual (2),
  // plural (3-10), and a reversion to singular for 11+.
  sessionsCount: (count: number, language: "ar" | "en"): string =>
    language === "ar"
      ? arabicSessionsCount(count)
      : `${count} ${count === 1 ? "session" : "sessions"}`,
  // sessionId is renderer-supplied and echoed straight into the sentence;
  // capped so a caller passing something unbounded (accidentally or not)
  // cannot blow up the size of a string that ends up rendered in the UI.
  unknownSession: (sessionId: string, language: "ar" | "en"): string => {
    const id = sessionId.length > 100 ? `${sessionId.slice(0, 100)}…` : sessionId;
    return language === "ar"
      ? `لا أعرف جلسة بهذا المعرّف: ${id}`
      : `I don't know a session with that id: ${id}`;
  },
  // Shown when an IPC call arrives with an argument of the wrong type (a
  // buggy renderer caller, not necessarily a malicious one) — never echoes
  // the bad value back, since its shape/type is exactly what's untrusted.
  invalidArgument: (language: "ar" | "en"): string =>
    language === "ar" ? "طلب غير صالح." : "Invalid request.",
  // Shown for the whole time an Editor tab is waiting on code-server to
  // boot. Measured at 1.9-2.3s with the binaries warm and 9-13s cold, and
  // it used to be spent with an empty toolbar — the app looked frozen. The
  // wait belongs to code-server and cannot be removed, so it is stated.
  editorStarting: (language: "ar" | "en"): string =>
    language === "ar" ? "جارٍ تشغيل المحرر…" : "Starting the editor…",
  // The same, for DbGate. Its cold start was measured at 21.6s, so this is
  // the message a user is most likely to sit and read.
  databaseStarting: (language: "ar" | "en"): string =>
    language === "ar" ? "جارٍ تشغيل متصفح قواعد البيانات…" : "Starting the database browser…",
  // Shown when a code-server instance fails to start or become ready for
  // an Editor tab — the one caller left of what used to be the doc
  // viewer's shared failure text.
  editorUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر فتح المحرر." : "Could not open the editor.",
  // Shown when a DbGate instance fails to start or become ready for a
  // Database tab. Covers both "dbgate-serve is not installed" and "it never
  // began listening": the manager's own detail (a missing binary, a port
  // that was never announced) is developer-facing and rides underneath,
  // same split as editorUnavailable above.
  databaseUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر فتح قاعدة البيانات." : "Could not open the database browser.",
  // Shown when a headlamp-server instance fails to start or become ready
  // for a Cluster tab. Covers "the binary is not installed", "it never
  // began listening" and "the context is gone from the kubeconfig" alike:
  // the manager's own detail rides underneath, same split as
  // editorUnavailable and databaseUnavailable.
  clusterUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر فتح متصفّح العنقود." : "Could not open the cluster browser.",
  // Covers both halves of "main will not open that": a project it does not
  // know, and a chat name the project does not declare. There is nothing
  // spawned behind a chat tab, so unlike the three above this headline
  // never has a manager's detail underneath it.
  chatUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر فتح تلك المحادثة." : "Could not open that chat.",
  // Shown when ensureAwsSession's wait for saml2aws login to finish (typed
  // into a Workspace Terminal tab) runs out the clock — the terminal is left
  // open rather than closed out from under the user mid-login.
  clusterLoginTimedOut: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لم تكتمل عملية الدخول إلى AWS في الوقت المحدد. تحقّق من الطرفية وحاول مرة أخرى."
      : "AWS login did not finish in time. Check the terminal and try again.",
  dockerNotInstalled: (language: "ar" | "en"): string =>
    language === "ar"
      ? "دوكر غير مثبّت، أو غير موجود في مسار الصدفة."
      : "Docker is not installed, or is not on the shell PATH.",
  dockerDaemonDown: (language: "ar" | "en"): string =>
    language === "ar" ? "خدمة دوكر لا تعمل." : "The Docker daemon is not running.",
  dockerNoContainers: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا توجد حاويات مهيأة لهذا المشروع"
      : "No containers configured for this project",
  dockerUnknownContainer: (language: "ar" | "en"): string =>
    language === "ar"
      ? "هذه الحاوية غير مهيأة لهذا المشروع."
      : "That container is not configured for this project.",
  // docker:follow's per-device cap (docker-followers.ts,
  // MAX_REMOTE_FOLLOWERS_PER_DEVICE = 4) — a phone that already has that
  // many Docker log tabs open is told to close one, rather than the
  // desktop silently spawning a fifth unbounded `docker logs -f` child for
  // that device.
  dockerFollowLimit: (language: "ar" | "en"): string =>
    language === "ar"
      ? "بلغ هذا الجهاز الحد الأقصى لعدد سجلات دوكر المتابَعة في آن واحد."
      : "This device already has the maximum number of Docker logs open at once.",
  // Distinct from dockerNoContainers: this project *has* containers, they
  // simply do not form one compose stack, so up and down have no target.
  dockerNoComposeProject: (language: "ar" | "en"): string =>
    language === "ar"
      ? "هذه الحاويات لا تنتمي إلى حزمة compose واحدة."
      : "These containers do not belong to a single compose project.",
  // Distinct again from dockerNoComposeProject: the containers *do* share one
  // compose project, but none of them carries the
  // com.docker.compose.project.working_dir label, so `compose up` has no
  // directory to run in. `down` still works — it needs only the project name.
  dockerNoComposeWorkingDir: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا يُعرف مجلد ملف compose لهذه الحزمة، فتعذّر تشغيلها."
      : "The compose file's directory for this stack is unknown, so it cannot be brought up.",
  // The row actions are glyphs, so their accessible name is the only thing
  // that says what they do — carried on both `title` and `aria-label`, for
  // the pointer and for a screen reader.
  dockerActionStart: (language: "ar" | "en"): string =>
    language === "ar" ? "تشغيل الحاوية" : "Start the container",
  dockerActionStop: (language: "ar" | "en"): string =>
    language === "ar" ? "إيقاف الحاوية" : "Stop the container",
  dockerActionRestart: (language: "ar" | "en"): string =>
    language === "ar" ? "إعادة تشغيل الحاوية" : "Restart the container",
  dockerActionShell: (language: "ar" | "en"): string =>
    language === "ar" ? "فتح صدفة داخل الحاوية" : "Open a shell inside the container",
  /** The count line under the pane's heading. "of N" rather than a
   *  running/stopped split because a container declared in `docker:` that
   *  Docker does not have is neither — and the total stays honest when one
   *  goes missing. */
  dockerRunningCount: (running: number, total: number, language: "ar" | "en"): string =>
    language === "ar" ? `${running} من ${total} تعمل` : `${running} of ${total} running`,
  dockerNoSelection: (language: "ar" | "en"): string =>
    language === "ar" ? "لم تُحدَّد حاوية" : "No container selected",
  dockerHeading: (language: "ar" | "en"): string => (language === "ar" ? "الحاويات" : "Containers"),
  dockerConfirmStop: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `إيقاف ${name}؟` : `Stop ${name}?`,
  dockerConfirmRestart: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `إعادة تشغيل ${name}؟` : `Restart ${name}?`,
  dockerConfirmComposeDown: (project: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `إيقاف حزمة ${project} وإزالة حاوياتها؟`
      : `Take down the ${project} stack? This removes its containers.`,
  // headlamp-server was measured at roughly twelve seconds cold — longer
  // than code-server, shorter than DbGate — so the toolbar says so for the
  // whole wait rather than leaving the app looking frozen.
  clusterStarting: (language: "ar" | "en"): string =>
    language === "ar" ? "جارٍ تشغيل متصفّح العنقود…" : "Starting the cluster browser…",
  // A project that declares no `clusters:` has nothing for the button to
  // open, which is most projects and always the personal browser. Its own
  // reason rather than personalHasNoDirectory: a cluster is not rooted in a
  // directory, so "no directory on disk" would be a false explanation.
  noClustersConfigured: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا توجد عناقيد مُعرَّفة لهذا المشروع."
      : "No clusters configured for this project.",
  // Follows noClustersConfigured exactly, and for the same reason: a chat
  // is not rooted in a directory either, so the personal browser's own
  // explanation would be the wrong one here.
  noChatConfigured: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا توجد محادثات مُعرَّفة لهذا المشروع."
      : "No chat configured for this project.",
  // The API tab's failures: a collection that could not be read, a request
  // that could not be saved, a runner that threw. The runner's own detail
  // (a refused connection, a DNS failure) is developer-facing and rides
  // underneath, same split as editorUnavailable.
  apiUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر تنفيذ الطلب." : "Could not run the request.",
  apiNoCollections: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا توجد مجموعات في هذا المشروع. أنشئ مجلدًا يحتوي على bruno.json."
      : "No collections in this project. Create a folder containing bruno.json.",
  apiDiscardEdits: (language: "ar" | "en"): string =>
    language === "ar" ? "تجاهل التعديلات غير المحفوظة؟" : "Discard unsaved changes?",
  apiUnresolved: (names: string, language: "ar" | "en"): string =>
    language === "ar" ? `متغيرات بلا قيمة: ${names}` : `No value for: ${names}`,
  // Scripts are preserved on save but never executed here, so a request that
  // carries one behaves differently than it would under `bru run`. Saying so
  // beats letting someone trust a green result.
  apiScriptsNotRun: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لم تُنفَّذ السكربتات الخاصة بهذا الطلب."
      : "This request carries a script, which is not run here.",
  apiNewRequest: (language: "ar" | "en"): string =>
    language === "ar" ? "طلب جديد" : "New request",
  apiNewFolder: (language: "ar" | "en"): string => (language === "ar" ? "مجلد جديد" : "New folder"),
  apiNewCollection: (language: "ar" | "en"): string =>
    language === "ar" ? "مجموعة جديدة" : "New collection",
  apiImport: (language: "ar" | "en"): string =>
    language === "ar" ? "استيراد من Postman" : "Import from Postman",
  apiRename: (language: "ar" | "en"): string => (language === "ar" ? "إعادة تسمية" : "Rename"),
  apiDelete: (language: "ar" | "en"): string => (language === "ar" ? "حذف" : "Delete"),
  apiConfirmDelete: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `حذف ${name}؟` : `Delete ${name}?`,
  apiCopyCurl: (language: "ar" | "en"): string =>
    language === "ar" ? "نسخ كـ cURL" : "Copy as cURL",
  apiCopied: (language: "ar" | "en"): string => (language === "ar" ? "تم النسخ" : "Copied"),
  apiNoRequest: (language: "ar" | "en"): string =>
    language === "ar" ? "اختر طلبًا من القائمة." : "Pick a request from the list.",
  apiSending: (language: "ar" | "en"): string => (language === "ar" ? "جارٍ الإرسال…" : "Sending…"),
  // Assertions are evaluated here; scripts are not. The two live in the same
  // file and it must be clear which of them actually ran.
  apiTestsPassed: (passed: number, total: number, language: "ar" | "en"): string =>
    language === "ar" ? `نجح ${passed} من ${total}` : `${passed} of ${total} passed`,
  apiNoHistory: (language: "ar" | "en"): string =>
    language === "ar" ? "لا يوجد سجل بعد." : "Nothing sent yet.",
  apiNoCookies: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد كوكيز محفوظة." : "No cookies stored.",
  apiNoConsole: (language: "ar" | "en"): string =>
    language === "ar" ? "لم تطبع السكربتات شيئًا." : "The scripts printed nothing.",
  apiNoTests: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد تحققات لهذا الطلب." : "This request has no assertions.",
  // The bookmark store's failures (a disk write that failed, mainly) —
  // never echoes the store's own developer-facing detail.
  bookmarksUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر حفظ العلامات المرجعية." : "Could not save bookmarks.",
  /** The pencil on a bookmark chip and on an essential tile, and the label
   *  on the row it opens. */
  renameBookmark: (language: "ar" | "en"): string =>
    language === "ar" ? "إعادة تسمية الإشارة المرجعية" : "Rename bookmark",
  /** The store refuses a rename to nothing; this is the only place that
   *  turns its "blank-title" token into words. The chip shows the raw url
   *  when a title is empty, so a blank rename would read as a broken
   *  bookmark rather than as a rename that did what it was told. */
  bookmarkBlankTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "اسم الإشارة المرجعية لا يمكن أن يكون فارغًا." : "A bookmark needs a name.",
  /** The store refuses a thirteenth pin; this is the only place that turns
   *  its "pin-limit" token into words. */
  bookmarkPinLimit: (limit: number, language: "ar" | "en"): string =>
    language === "ar"
      ? `لا يمكن تثبيت أكثر من ${limit} إشارة في الشبكة.`
      : `The grid holds ${limit} bookmarks; unpin one first.`,
  // Stands in the bookmarks list when the selected project has none. An
  // empty column in the sidebar reads as a rendering glitch rather than as
  // an empty list, and the star that fills it is two elements away in the
  // same chrome.
  noBookmarks: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا توجد علامات مرجعية — احفظ صفحة بالنجمة ★"
      : "No bookmarks yet — save a page with the ★",
  /** The accessible name of the pin control on a listed row — the click and
   *  keyboard path to the essentials grid, beside the drag one. */
  pinBookmark: (language: "ar" | "en"): string =>
    language === "ar" ? "تثبيت في الشبكة" : "Pin to the grid",
  /** The accessible name of the unpin action on a grid tile — the way back
   *  out of the grid without a drag. */
  unpinBookmark: (language: "ar" | "en"): string =>
    language === "ar" ? "إلغاء التثبيت" : "Unpin from the grid",
  /** Stands in the essentials grid while nothing is pinned. The grid keeps
   *  its height either way (it is the drop target for a dragged row), so
   *  without this it is a blank band with no explanation. */
  noEssentials: (language: "ar" | "en"): string =>
    language === "ar"
      ? "اسحب علامة مرجعية إلى هنا لتثبيتها"
      : "Drag a bookmark here, or use its pin",
  /** The ☰ button beside the address bar: the sidebar's own toggle. */
  toggleBookmarksSidebar: (language: "ar" | "en"): string =>
    language === "ar"
      ? "إظهار أو إخفاء شريط العلامات الجانبي"
      : "Show or hide the bookmarks sidebar",
  // Why a Resume button refused. One message for every reason — the agent
  // gone from the config, the recorded directory deleted, the spawn itself
  // failing — because to the reader they are the same fact: this
  // conversation cannot be picked back up, and the transcript above is
  // still readable either way.
  cannotResumeSession: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر استئناف هذه الجلسة." : "This session cannot be resumed.",
  unknownProject: (language: "ar" | "en"): string =>
    language === "ar" ? "لا أعرف مشروعًا بهذا الاسم." : "I don't know a project by that name.",
  // The personal browser's name in the project selector. Its *key* is the
  // reserved "__personal__" (see personal.ts) — never shown; this is what
  // the user reads, beside project names they chose themselves.
  personalProject: (language: "ar" | "en"): string => (language === "ar" ? "شخصي" : "Personal"),
  // Why Editor / Database / Terminal / API are dead while the personal
  // browser is selected. A disabled control with no stated reason reads as
  // a bug, so this goes into the tool status line beside them.
  personalHasNoDirectory: (language: "ar" | "en"): string =>
    language === "ar"
      ? "المتصفح الشخصي بلا مجلد على القرص — لا محرر ولا قاعدة بيانات ولا طرفية ولا واجهة برمجة."
      : "The personal browser has no folder on disk — no editor, database, terminal or API.",
  // The Picture-in-Picture button, shown only while the page actually has a
  // video playing.
  pictureInPicture: (language: "ar" | "en"): string =>
    language === "ar" ? "شغّل الفيديو في نافذة عائمة" : "Float this video above everything",
  // The DevTools toggle in the address bar. Right-click is the only way back
  // from an undocked window, so the tooltip has to say it exists.
  devToolsToggle: (language: "ar" | "en"): string =>
    language === "ar"
      ? "أدوات المطوّر لهذه الصفحة — انقر بزر الفأرة الأيمن لاختيار مكانها"
      : "DevTools for this page — right-click to choose where they dock",
  devToolsDock: (side: "undocked" | "left" | "bottom" | "right", language: "ar" | "en"): string => {
    const ar = {
      undocked: "في نافذة منفصلة",
      left: "على اليسار",
      bottom: "في الأسفل",
      right: "على اليمين",
    };
    const en = {
      undocked: "Undock into a separate window",
      left: "Dock to left",
      bottom: "Dock to bottom",
      right: "Dock to right",
    };
    return language === "ar" ? `ثبّت أدوات المطوّر ${ar[side]}` : en[side];
  },
  devToolsClose: (language: "ar" | "en"): string =>
    language === "ar" ? "أغلق أدوات المطوّر" : "Close DevTools",
  // Settings' save flow. The headline is bilingual per the Global
  // Constraint every other view follows; parseConfig's own thrown message
  // (English, developer-facing — e.g. "Config `agents.x.command` must be a
  // string") is shown underneath it verbatim, the same headline-plus-
  // technical-detail split the Changes view and Providers panel already use.
  settingsSaveFailed: (language: "ar" | "en"): string =>
    language === "ar"
      ? "تعذّر حفظ الإعدادات — التفاصيل أدناه."
      : "Couldn't save settings — see below.",
  settingsSaved: (language: "ar" | "en"): string => (language === "ar" ? "تم الحفظ." : "Saved."),
  settingsSavedLive: (language: "ar" | "en"): string =>
    language === "ar" ? "تم الحفظ. التغييرات مفعّلة الآن." : "Saved. Changes are active now.",
  settingsSavedRestart: (language: "ar" | "en"): string =>
    language === "ar"
      ? "تم الحفظ. أعد التشغيل لتطبيق تغييرات خدمات البدء."
      : "Saved. Restart to apply startup-service changes.",
  reloadJarvis: (language: "ar" | "en"): string =>
    language === "ar" ? "إعادة تحميل جارفيس" : "Reload Jarvis",
  deleteBlock: (language: "ar" | "en"): string =>
    language === "ar" ? "حذف الكتلة" : "Delete block",
  deleteBlockTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "احذف هذه الكتلة" : "Delete this block",
  prayerHeading: (language: "ar" | "en"): string =>
    language === "ar" ? "مواقيت الصلاة" : "PRAYER TIMES",
  prayerShow: (language: "ar" | "en"): string =>
    language === "ar" ? "اعرض الصلاة القادمة في الرأس" : "show next prayer in header",
  prayerLatitude: (language: "ar" | "en"): string => (language === "ar" ? "خط العرض" : "latitude"),
  prayerLongitude: (language: "ar" | "en"): string =>
    language === "ar" ? "خط الطول" : "longitude",
  prayerUseLocation: (language: "ar" | "en"): string =>
    language === "ar" ? "استخدم موقعي" : "Use my location",
  prayerNotifyBefore: (language: "ar" | "en"): string =>
    language === "ar" ? "التنبيه قبل الصلاة" : "notify before prayer",
  prayerNotifyBeforeMinutes: (language: "ar" | "en"): string =>
    language === "ar" ? "الدقائق" : "minutes",
  prayerNotifyAtTime: (language: "ar" | "en"): string =>
    language === "ar" ? "التنبيه عند وقت الصلاة" : "notify at prayer time",
  prayerLocationNote: (language: "ar" | "en"): string =>
    language === "ar"
      ? "تُستخدم طريقة الحساب المصرية. يطلب macOS الموقع عبر CoreLocation. على Linux وWindows قد يتصل Chromium بخدمة الموقع من Google وقد يفشل بلا مفتاح. يمكنك إدخال الإحداثيات يدويًا."
      : "Uses the Egyptian calculation method. macOS asks CoreLocation. On Linux and Windows, Chromium may contact Google's location service and can fail without a key. You can enter coordinates manually.",
  prayerAlexandria: (language: "ar" | "en"): string =>
    language === "ar" ? "الإسكندرية" : "Alexandria",
  prayerCustomLocation: (language: "ar" | "en"): string =>
    language === "ar" ? "موقع مخصص" : "Custom location",
  prayerName: (name: string, language: "ar" | "en"): string => {
    if (language === "en") return name === "Prayer" ? "Prayer" : name;
    return (
      (
        {
          Fajr: "الفجر",
          Dhuhr: "الظهر",
          Asr: "العصر",
          Maghrib: "المغرب",
          Isha: "العشاء",
          Prayer: "الصلاة",
        } as Record<string, string>
      )[name] ?? name
    );
  },
  prayerDuration: (hours: number, minutes: number, language: "ar" | "en"): string =>
    language === "ar"
      ? hours > 0
        ? `${hours} س ${minutes} د`
        : `${minutes} د`
      : hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m`,
  prayerUnavailable: (language: "ar" | "en"): string =>
    language === "ar"
      ? "الموقع غير متاح؛ تُستخدم الإسكندرية"
      : "Location unavailable; using Alexandria",
  prayerLocating: (language: "ar" | "en"): string =>
    language === "ar" ? "جارٍ تحديد الموقع…" : "Locating…",
  prayerCurrentLocation: (language: "ar" | "en"): string =>
    language === "ar" ? "الموقع الحالي" : "Current location",
  prayerDenied: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `رُفض الموقع؛ يُستخدم ${name}` : `Location denied; using ${name}`,
  prayerNext: (name: string, duration: string, language: "ar" | "en"): string =>
    language === "ar" ? `${name} بعد ${duration}` : `${name} in ${duration}`,
  // The 5 minutes right after a prayer's own time — the header names it
  // rather than counting down to whatever comes next (prayer.ts's own
  // "justPassed" window).
  prayerNow: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `${name} الآن` : `${name} now`,
  prayerTitle: (location: string, name: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `${location} · الصلاة القادمة ${name}`
      : `${location} · next prayer ${name}`,
  // board 0's topbar carries no numbers any more — the Dashboard SYSTEM
  // panel is the only place CPU/RAM/DISK render — but a machine in real
  // trouble still needs a signal from every route, so a small danger dot
  // takes their place, named in its own tooltip instead of a number. Takes
  // which readings are critical rather than a pre-joined string, so the
  // Arabic "and" is never spliced onto an English word list.
  topbarDangerTitle: (
    cpuCritical: boolean,
    diskCritical: boolean,
    language: "ar" | "en",
  ): string => {
    const cpu = language === "ar" ? "المعالج" : "CPU";
    const disk = language === "ar" ? "القرص" : "disk";
    const and = language === "ar" ? "و" : " and ";
    const names = [cpuCritical ? cpu : undefined, diskCritical ? disk : undefined]
      .filter((name): name is string => name !== undefined)
      .join(and);
    return language === "ar" ? `${names} مرتفع جدًا` : `${names} critically high`;
  },
  renameTab: (language: "ar" | "en"): string =>
    language === "ar" ? "إعادة تسمية علامة التبويب" : "Rename tab",
  // The chip's own tooltip — double-click is the fast path, but nothing on
  // the chip itself said so until the right-click menu below existed to
  // explain it from.
  tabRenameHint: (language: "ar" | "en"): string =>
    language === "ar" ? "انقر نقرًا مزدوجًا لإعادة التسمية" : "Double-click to rename",
  // The right-click menu's own three items — short, unlike renameTab above
  // (that one labels the rename input itself, not a menu row beside Reload
  // and Close).
  tabMenuRename: (language: "ar" | "en"): string => (language === "ar" ? "إعادة تسمية" : "Rename"),
  tabMenuReload: (language: "ar" | "en"): string => (language === "ar" ? "إعادة تحميل" : "Reload"),
  tabMenuClose: (language: "ar" | "en"): string => (language === "ar" ? "إغلاق" : "Close"),
  // Ruling P22: gitChanges() always reads the repository's current working
  // tree, never a per-session snapshot. For a session that has already
  // ended, showing that data under its name would repeat exactly the lie
  // ruling P21 removed from the session badge — so the Changes view says
  // so plainly instead of pretending the file list is that session's own
  // work. Task 16's per-session recorded git metadata retires this notice.
  changesShowCurrentState: (agentId: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `انتهت هذه الجلسة — ما يظهر أدناه هو الحالة الحالية للمستودع، وليس بالضرورة ما كتبه ${agentId}.`
      : `This session has ended — what's shown below is the repository's current state, not necessarily ${agentId}'s work.`,
  // GitFileDiff.binary: git itself (or a NUL-byte read) confirmed the file
  // is not text, so there is no line-by-line diff to draw at all.
  //
  // Ruling P25: the pane and the voice lane (core's gitDiffOpenedText,
  // packages/core/src/git/messages.ts) describe the same condition in the
  // same moment for the same file, so they use the same wording — this is
  // that sentence minus its trailing `: ${path}` clause, since the pane
  // already shows the filename in its own header and does not need it
  // repeated inside the note.
  diffBinaryFile: (language: "ar" | "en"): string =>
    language === "ar" ? "هذا ملف ثنائي ولا يمكن عرض فروقه." : "Binary file — no diff to show.",
  // GitFileDiff.tooLarge (ruling P8): the file or its diff exceeded the
  // provider's size cap and was never read, so this is deliberately a
  // different sentence from diffBinaryFile — "too big to show" is not the
  // same fact as "not text", and conflating them was Task 14's first-draft
  // mistake this message exists to avoid repeating. Wording reused from
  // core's gitDiffOpenedText per ruling P25, same as diffBinaryFile above.
  diffTooLarge: (language: "ar" | "en"): string =>
    language === "ar" ? "الملف كبير جدًا لعرض الفروق." : "Too large to show a diff for.",
  // hunks.length === 0 with binary and tooLarge both false: a real diff
  // read that simply found nothing to show (e.g. a mode-only change, or
  // the file picked from the list has since gone back to matching HEAD).
  diffNoChanges: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد تغييرات لعرضها." : "No changes to show.",
  // I2: the Changes view shipped as an English-only lane in an
  // Arabic-primary app (Global Constraints names this exact defect — it was
  // a real phase-1 regression). Every string below routes through here
  // instead of a literal in changes.ts/index.html.
  //
  // "Commit N files" is the sharpest case: a counted noun, not a sentence
  // with a number dropped in — exactly what arabicSessionsCount above
  // exists for. It uses a table of its own (arabicFilesCount below), *not*
  // arabicSessionsCount's: see the comment on arabicFilesCount for why the
  // two must stay separate despite looking identical in shape.
  //
  // count === 0 is a case of its own rather than arabicFilesCount("لا ملفات"
  // etc.): "حفظ" (Save/Commit) is a transitive verbal noun, and "Save no
  // files" is not a grammatical verb-object phrase in Arabic any more than
  // it reads naturally in English — there is no noun for it to govern. The
  // button is disabled at zero anyway, so the bare verb is what's shown.
  commitButtonLabel: (count: number, language: "ar" | "en"): string =>
    language === "ar"
      ? count === 0
        ? "حفظ"
        : `حفظ ${arabicFilesCount(count)}`
      : `Commit ${count} ${count === 1 ? "file" : "files"}`,
  // `ago` is formatAgo()'s own already-localised output; this just joins it
  // to the agent id as one label/value pair, same shape as the rest of this
  // table.
  writtenBy: (agentId: string, ago: string, language: "ar" | "en"): string =>
    language === "ar" ? `بواسطة ${agentId} · ${ago}` : `written by ${agentId} · ${ago}`,
  navDashboard: (language: "ar" | "en"): string => (language === "ar" ? "اللوحة" : "Dashboard"),
  navChanges: (language: "ar" | "en"): string => (language === "ar" ? "التغييرات" : "Changes"),
  navSession: (language: "ar" | "en"): string => (language === "ar" ? "الجلسة" : "Session"),
  // The Session view's empty state, before the agent has printed anything.
  // Distinct from "this session produced no output at all": a just-started
  // process routinely sits here for a second or two.
  sessionNoOutput: (language: "ar" | "en"): string =>
    language === "ar" ? "لا يوجد إخراج بعد…" : "No output yet…",
  // Shown when no session has been started, so there is nothing to open.
  sessionNone: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد جلسة مفتوحة." : "No session open.",
  // The Refresh button's aria-label, in both the Sessions view header and
  // the Dashboard SESSIONS card header — one label, since both trigger the
  // same sessions:refresh scan.
  refreshSessions: (language: "ar" | "en"): string =>
    language === "ar" ? "تحديث الجلسات" : "Refresh sessions",
  // A row process-scan.ts found running outside Jarvis — the chip that
  // marks it read-only in both the session table and its own header.
  sessionOutsideJarvis: (language: "ar" | "en"): string =>
    language === "ar" ? "خارج جارفيس" : "outside Jarvis",
  // An external row's summary before any transcript has been matched to it
  // (session-import.ts's own comment applies here too: liveness is a guess
  // no file can prove, so this says only that the process exists, never
  // that it is "running" in a sense Jarvis observed).
  sessionRunningOutsideJarvis: (language: "ar" | "en"): string =>
    language === "ar" ? "قيد التشغيل خارج جارفيس" : "Running outside Jarvis",
  // Shown when an external row's process was found but no transcript could
  // be matched to it — distinct from sessionNone, which means no session is
  // open at all.
  sessionNoTranscript: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا يوجد نص محادثة لهذه الجلسة بعد."
      : "No transcript found for this session yet.",
  // Where speech lands while a session's terminal is open. Named
  // explicitly because it is the one thing about voice the terminal itself
  // cannot show, and being wrong about it means talking to another agent.
  voiceGoesHere: (language: "ar" | "en"): string =>
    language === "ar" ? "⌥Space يتحدث إلى هذه الجلسة" : "⌥Space talks to this session",
  voiceListeningHere: (language: "ar" | "en"): string =>
    language === "ar" ? "يستمع… إلى هذه الجلسة" : "Listening… to this session",
  changedFilesLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "الملفات المعدّلة" : "CHANGED FILES",
  // The header's repo-path/branch separator ("~/projects/acme on
  // feat/checkout-retry"). Both neighbouring values are technical tokens
  // (a filesystem path, a git ref) that stay LTR regardless of language, so
  // this is the same preposition English uses, not a sentence to reorder.
  pathBranchSeparator: (language: "ar" | "en"): string => (language === "ar" ? "على" : "on"),
  sideBySideLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "جنبًا إلى جنب" : "Side by side",
  unifiedLabel: (language: "ar" | "en"): string => (language === "ar" ? "موحّد" : "Unified"),
  beforeColumnLabel: (language: "ar" | "en"): string => (language === "ar" ? "قبل" : "BEFORE"),
  afterColumnLabel: (language: "ar" | "en"): string => (language === "ar" ? "بعد" : "AFTER"),
  testsGroupLabel: (language: "ar" | "en"): string => (language === "ar" ? "الاختبارات" : "TESTS"),
  commitMessagePlaceholder: (language: "ar" | "en"): string =>
    language === "ar" ? "رسالة الحفظ…" : "Commit message…",
  stageFileLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "تجهيز الملف" : "Stage file",
  unstageFileLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "إلغاء تجهيز الملف" : "Unstage file",
  // Providers panel chrome (Task 9). The account-status *sentences*
  // (providerStatusLine et al.) belong to @jarvis/core's own messages.ts —
  // these are only the panel's own labels, same split as everywhere else
  // in this file (I2: no English-only lane beside a bilingual table).
  //
  // The panel header itself stays the hardcoded literal "Providers" in
  // index.html, consistent with the other four hardcoded English panel
  // titles (System, Sessions, Conversation, History) — translating this
  // one alone is a product decision about the whole dashboard, not this
  // feature's to make (ruling S22).
  providersEmpty: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد حسابات مُعرّفة." : "No providers are configured.",
  // The row's own label. "LEFT", not "USED": the System panel above shows
  // consumption, this shows headroom, and the label is what makes the
  // meter's direction unambiguous.
  capacityLeftLabel: (language: "ar" | "en"): string => (language === "ar" ? "المتبقي" : "LEFT"),
  // Three different facts, never collapsed into one "unknown".
  capacityUnsupported: (language: "ar" | "en"): string =>
    language === "ar" ? "لا يوفّر قراءة للسعة" : "no capacity reading available",
  // Every source is free (a snapshot file, Codex's logs, the signed-in gh —
  // SETUP.md §5): unavailable means that account's source has produced
  // nothing yet, so the row says where to look.
  capacityUnavailable: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا توجد قراءة استخدام بعد — راجع الإعداد §5"
      : "no usage reading yet — see Setup §5",
  capacityNeverRead: (language: "ar" | "en"): string =>
    language === "ar" ? "لم تُقرأ السعة بعد" : "capacity not checked yet",
  // `clock` is an already-formatted HH:MM value, interpolated at the tail.
  // Ruling P30: never "resets in 3 hours" — an absolute time needs no
  // counted noun in Arabic and stays true as the reading ages.
  capacityResetsAt: (clock: string, language: "ar" | "en"): string =>
    language === "ar" ? `يتجدد ${clock}` : `resets ${clock}`,
  capacityAsOf: (clock: string, language: "ar" | "en"): string =>
    language === "ar" ? `حتى ${clock}` : `as of ${clock}`,
  refreshProviders: (language: "ar" | "en"): string =>
    language === "ar" ? "تحديث حالة الحسابات" : "Refresh provider status",
  providerHealth: (state: "degraded" | "outage" | "unknown", language: "ar" | "en"): string => {
    if (state === "degraded") return language === "ar" ? "الخدمة متعثرة" : "service degraded";
    if (state === "outage") return language === "ar" ? "الخدمة متوقفة" : "service down";
    return language === "ar" ? "حالة الخدمة غير معروفة" : "service status unknown";
  },

  // The Dashboard's core stage (design/DashboardBrain.dc.html): the PROJECTS
  // label sits beside a live filter and a running/waiting readout, unlike the
  // other four panel titles (System/Sessions/Providers/Conversation), which
  // stay the hardcoded English literals ruling S22 fixed them as — those are
  // static chrome, but this label shares a line with genuinely dynamic,
  // already-bilingual text (the filter placeholder, the counts), so it goes
  // through the same table rather than being the one English word among them.
  dashboardProjectsLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "المشاريع" : "PROJECTS",
  dashboardFilterPlaceholder: (language: "ar" | "en"): string =>
    language === "ar" ? "تصفية…" : "Filter…",
  // The filter input's own accessible name — visually hidden, same pattern
  // as design/DashboardBrain.dc.html's `<label for="pf">`.
  dashboardFilterLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "تصفية المشاريع" : "Filter projects",
  // Shared by the core stage's own readout and the SESSIONS card header,
  // which show the identical "N running · M waiting" fact in two places
  // (design/DashboardBrain.dc.html rows 1 and 3) — one table entry keeps them
  // from drifting apart in wording.
  dashboardRunningWaiting: (running: number, waiting: number, language: "ar" | "en"): string =>
    language === "ar"
      ? `${running} قيد التشغيل · ${waiting} في الانتظار`
      : `${running} running · ${waiting} waiting`,
  dashboardAllSessions: (language: "ar" | "en"): string =>
    language === "ar" ? "كل الجلسات" : "All sessions",
  // A project node's own per-project badge, distinct from the header's
  // combined running-and-waiting count above.
  dashboardNodeRunning: (count: number, language: "ar" | "en"): string =>
    language === "ar" ? `${count} قيد التشغيل` : `${count} running`,
  dashboardNodeWaiting: (language: "ar" | "en"): string =>
    language === "ar" ? "قيد الانتظار" : "waiting",
  // An idle node's status line: the word alone, or the word plus whatever the
  // project row already knows (its dirty file count — no new IPC invents a
  // richer fact than that for this redesign).
  dashboardIdle: (language: "ar" | "en"): string => (language === "ar" ? "خامل" : "idle"),
  dashboardIdleDirty: (files: number, language: "ar" | "en"): string =>
    language === "ar" ? `${files} ملفات معدّلة` : `${files} changed`,
  dashboardNoProjects: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا مشاريع معدّة. أضف واحدًا من الإعدادات."
      : "No projects configured. Add one in Settings.",
  dashboardNoMatches: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد مشاريع مطابقة." : "No matching projects.",
  dashboardNoSessions: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد جلسات بعد." : "No sessions yet.",
  // A project node's four icon-only shortcuts (design/DashboardBrain.dc.html's
  // `.actions`) — aria-label and title both, since the button carries no
  // visible text of its own (round 4: it used to be the label itself,
  // rendered as unbounded text that overflowed the card).
  dashboardActionTerminal: (language: "ar" | "en"): string =>
    language === "ar" ? "الطرفية" : "Terminal",
  dashboardActionEditor: (language: "ar" | "en"): string =>
    language === "ar" ? "المحرر" : "Editor",
  dashboardActionBrowser: (language: "ar" | "en"): string =>
    language === "ar" ? "المتصفح" : "Browser",
  dashboardActionDocker: (language: "ar" | "en"): string => (language === "ar" ? "دوكر" : "Docker"),

  // Settings → Remote access. Every line of this panel is bilingual, its
  // title included, unlike the older section titles (ruling S22): it is new,
  // and its warning is the one sentence in Settings that must never exist in
  // only one language.
  remoteTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "الوصول عن بُعد" : "REMOTE ACCESS",
  remoteEnabledLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "السماح بالوصول عن بُعد" : "allow remote access",
  remoteState: (enabled: boolean, language: "ar" | "en"): string =>
    language === "ar" ? (enabled ? "مفعّل" : "متوقف") : enabled ? "On" : "Off",
  remoteReachableOn: (language: "ar" | "en"): string =>
    language === "ar" ? "متاح عبر" : "reachable on",
  // Loopback names no interface: "this machine only" is the whole fact, and
  // `lo0` versus `Loopback Pseudo-Interface 1` is noise. The others name the
  // interface because two LAN addresses (Wi-Fi and a Docker bridge) are
  // otherwise indistinguishable. "Tailscale" for the mesh kind: 100.64/10 is
  // also carrier-grade NAT space, but on a laptop an address there is
  // overwhelmingly a tailnet, and the real address is printed beside it.
  remoteBindChoiceLabel: (kind: BindKind, iface: string, language: "ar" | "en"): string => {
    const names = {
      ar: { lan: "الشبكة المحلية", mesh: "شبكة Tailscale", other: "شبكة أخرى" },
      en: { lan: "Local network", mesh: "Tailscale", other: "Other network" },
    };
    if (kind === "loopback") return language === "ar" ? "هذا الحاسوب فقط" : "This machine only";
    const name = names[language][kind];
    return iface === "" ? name : `${name} — ${iface}`;
  },
  // The two primary "reachable on" radios (round 3): a plain "Tailscale" /
  // "Local Wi-Fi" name with no interface suffix — the mono address beside it
  // is the detail, and Advanced… (below) is where every other choice,
  // interface name included, still lives.
  remoteTailscaleLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "شبكة Tailscale" : "Tailscale",
  remoteWifiLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "واي فاي محلي" : "Local Wi-Fi",
  remoteTailscaleMissing: (language: "ar" | "en"): string =>
    language === "ar"
      ? "ثبّت Tailscale على هذا الحاسوب وعلى الهاتف."
      : "Install Tailscale on this Mac and the phone.",
  remoteAdvancedLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "خيارات متقدمة…" : "Advanced…",
  remoteOtherAddress: (language: "ar" | "en"): string =>
    language === "ar" ? "عنوان آخر…" : "Other…",
  remoteOtherPlaceholder: (language: "ar" | "en"): string =>
    language === "ar" ? "عنوان IP، مثل 192.168.1.20" : "an IP address, e.g. 192.168.1.20",
  // Shown for every spelling of the unspecified address. Not refused — on a
  // trusted network that may be exactly what the user wants — but never
  // chosen without saying so.
  remoteAllInterfaces: (language: "ar" | "en"): string =>
    language === "ar"
      ? "هذا العنوان يستمع على كل شبكة يتصل بها هذا الحاسوب، بما فيها الشبكات التي ينضم إليها لاحقًا."
      : "This address listens on every network this machine is on, including ones it joins later.",
  remotePortLabel: (language: "ar" | "en"): string => (language === "ar" ? "المنفذ" : "port"),
  remotePortNote: (language: "ar" | "en"): string =>
    language === "ar"
      ? "القيمة 0 تختار منفذًا متاحًا، ويحمله رمز الإقران إلى الهاتف."
      : "0 picks a free port; the pairing code carries it to the phone.",
  remoteProxyLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "وكيل الأدوات الجانبية" : "sidecar proxy",
  remoteProxyNote: (language: "ar" | "en"): string =>
    language === "ar"
      ? "يتيح تبويبات المحرر وقواعد البيانات والعناقيد على الهاتف. يحتاج إلى شهادة حقيقية، مثل التي يصدرها tailscale cert."
      : "Opens the Editor, Database and Cluster tabs on the phone. Needs a real certificate, such as one from tailscale cert.",
  remotePushLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "الإشعارات الفورية" : "push notifications",
  remotePushNote: (language: "ar" | "en"): string =>
    language === "ar"
      ? "الجزء الوحيد الذي يمر عبر طرف ثالث: يصل الإشعار عن طريق Apple أو Google، لذلك لا يحمل أبدًا مخرجات الوكلاء ولا الملفات ولا الأوامر."
      : "The one part that involves a third party: a notification travels through Apple or Google, so it never carries agent output, files or commands.",
  // M12 Task 4: the bridge's own idle timer (M12 Task 1). 0 = never, same
  // convention as remotePortNote's "0 picks a free port" — a number field
  // whose zero has a named meaning, not a missing value.
  remoteIdleLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "الإيقاف التلقائي بعد (بالدقائق)" : "auto-disable after (minutes)",
  remoteIdleNote: (language: "ar" | "en"): string =>
    language === "ar"
      ? "0 = أبدًا. يُحتسب الوقت فقط أثناء عدم اتصال أي جهاز وعدم فتح رمز إقران."
      : "0 = never. Counts only while no device is connected and no pairing code is open.",
  // The state line under the idle field, rendered from RemoteStatus.idle
  // (bridge.ts's RemoteIdleStatus), never from the draft — the same
  // status-not-draft discipline remoteCertificateReal/SelfSigned follow.
  remoteIdleArmed: (disableAt: number, language: "ar" | "en"): string => {
    const formatted = new Date(disableAt).toLocaleString(language === "ar" ? "ar" : "en");
    return language === "ar"
      ? `سيتوقف الوصول عن بُعد تلقائيًا في ${formatted}`
      : `Will turn off automatically at ${formatted}`;
  },
  remoteIdleDisabled: (at: number, minutes: number, language: "ar" | "en"): string => {
    const formatted = new Date(at).toLocaleString(language === "ar" ? "ar" : "en");
    const arabicMinutes =
      minutes === 1
        ? "دقيقة واحدة"
        : minutes === 2
          ? "دقيقتين"
          : minutes <= 10
            ? `${minutes} دقائق`
            : `${minutes} دقيقة`;
    return language === "ar"
      ? `توقف الوصول عن بُعد تلقائيًا في ${formatted} بعد ${arabicMinutes} من الخمول`
      : `Turned off automatically at ${formatted} after ${minutes} min idle`;
  },
  // Ruling b: separate consent from remotePushLabel's switch, same reason
  // remoteProxyLabel is separate from remoteEnabledLabel — it widens what a
  // notification is allowed to say, not whether one is sent at all, so it
  // stays enabled even while push itself is off (the note explains why).
  remotePushProjectsLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "تضمين أسماء المشاريع" : "include project names",
  remotePushProjectsNote: (language: "ar" | "en"): string =>
    language === "ar"
      ? "عند الإيقاف: لا يذكر الإشعار اسم المشروع أبدًا."
      : "Off: a notification never names the project.",
  remotePairTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "إقران جهاز" : "Pair a device",
  remoteNewCode: (language: "ar" | "en"): string => (language === "ar" ? "رمز جديد" : "New code"),
  // The bridge is real now (M4). "New code" is disabled while the switch
  // above is off — turn it on and Save first.
  remotePairSaveFirst: (language: "ar" | "en"): string =>
    language === "ar"
      ? "فعّل الوصول عن بُعد واحفظ التغييرات أولًا لإقران جهاز."
      : "Turn on remote access and save first to pair a device.",
  remotePairInstructions: (language: "ar" | "en"): string =>
    language === "ar"
      ? "افتح تطبيق Jarvis على هاتفك وامسح أو الصق هذا الرابط قبل انتهاء صلاحيته."
      : "Open the Jarvis app on your phone and scan or paste this link before it expires.",
  // `tail` is always the last 4 hex characters of the pinned certificate's
  // fingerprint — same wording as the phone's own confirm step
  // (apps/mobile/src/lib/i18n.ts "pair.confirm"), so the two screens read
  // as the same comparison rather than two different phrasings of it.
  remotePairFingerprintTail: (tail: string, language: "ar" | "en"): string =>
    language === "ar" ? `الشهادة تنتهي بـ …${tail}.` : `Certificate ends in …${tail}.`,
  // "Expires in 1:47" — minutes:seconds, no leading zero on the minutes.
  remotePairExpires: (seconds: number, language: "ar" | "en"): string => {
    const clamped = Math.max(0, seconds);
    const minutes = Math.floor(clamped / 60);
    const rest = String(clamped % 60).padStart(2, "0");
    const clock = `${minutes}:${rest}`;
    return language === "ar" ? `تنتهي خلال ${clock}` : `Expires in ${clock}`;
  },
  remotePairCancel: (language: "ar" | "en"): string => (language === "ar" ? "إلغاء" : "Cancel"),
  // Templates carry a literal "{name}" placeholder rather than the caller
  // splicing the name into the returned string and having remote-status.ts
  // (or settings.ts) find it again with `indexOf(name)` — a name that
  // happens to equal one of the template's own words (an Arabic device
  // named "الجهاز", say) would otherwise match the *template's* word
  // instead of the real interpolation point. remote*Parts below hands back
  // the split already done, against the template itself, so the split is
  // correct regardless of what the name contains.
  remotePairWaiting: (name: string, language: "ar" | "en"): string => {
    const { before, after } = splitOnNamePlaceholder(REMOTE_PAIR_WAITING_TEMPLATE[language]);
    return `${before}${name}${after}`;
  },
  remotePairWaitingParts: (language: "ar" | "en"): { before: string; after: string } =>
    splitOnNamePlaceholder(REMOTE_PAIR_WAITING_TEMPLATE[language]),
  remoteDevicesTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "الأجهزة المقترنة" : "Paired devices",
  remoteNoDevices: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد أجهزة مقترنة." : "No devices are paired.",
  remoteDeviceConnected: (language: "ar" | "en"): string =>
    language === "ar" ? "متصل الآن" : "connected",
  // `at` is a plain timestamp (ms since epoch) with no per-device language
  // signal beyond the language it is rendered in — Intl's own locale tag
  // covers calendar/script/digit conventions for that language well enough
  // without a full per-device locale.
  remoteDeviceLastSeen: (at: number, language: "ar" | "en"): string => {
    const formatted = new Date(at).toLocaleString(language === "ar" ? "ar" : "en");
    return language === "ar" ? `آخر ظهور: ${formatted}` : `last seen ${formatted}`;
  },
  remoteDeviceNeverSeen: (language: "ar" | "en"): string =>
    language === "ar" ? "لم يتصل بعد" : "never connected",
  // Ruling h: platform only, mirroring RemoteDeviceStatus.push — never the
  // token, and never whether push itself is enabled on the laptop (that is
  // the switch above, remotePushLabel).
  remoteDevicePush: (platform: "ios" | "android", language: "ar" | "en"): string => {
    if (language === "ar") {
      return platform === "ios" ? "الإشعارات مفعّلة (آيفون)" : "الإشعارات مفعّلة (أندرويد)";
    }
    return platform === "ios" ? "Notifications on (iPhone)" : "Notifications on (Android)";
  },
  remoteRevoke: (language: "ar" | "en"): string => (language === "ar" ? "إلغاء الإقران" : "Revoke"),
  // The five RemoteProblem values the bridge's own gate can land on
  // (bridge.ts). Closed table for the same reason remoteErrorText is: a
  // problem added to the protocol without a translation here is a compile
  // error, not a silent English-only gap.
  remoteProblem: (problem: RemoteProblem, language: "ar" | "en"): string => {
    const text: Record<RemoteProblem, { ar: string; en: string }> = {
      "bad-address": {
        ar: "عنوان الاستماع المضبوط ليس عنوان IP صالحًا.",
        en: "The configured listening address is not a valid IP literal.",
      },
      "listen-failed": {
        ar: "تعذّر فتح منفذ الاستماع.",
        en: "Could not open the listening port.",
      },
      "certificate-failed": {
        ar: "تعذّر تجهيز شهادة TLS.",
        en: "Could not prepare a TLS certificate.",
      },
      "devices-unreadable": {
        ar: "تعذّرت قراءة ملف الأجهزة المقترنة، فبقي الوصول عن بُعد متوقفًا.",
        en: "The paired-devices file could not be read, so remote access stays off.",
      },
      "devices-write-failed": {
        ar: "تعذّر حفظ التغيير على الأجهزة المقترنة.",
        en: "Could not save that change to the paired devices.",
      },
    };
    return text[problem][language];
  },
  // The topbar's listening indicator (#remote-pill). "pairing open" mirrors
  // Settings' own pair-area note — the same fact, said briefly. Always
  // carries a short state word (never bare host:port), so `ar` and `en`
  // differ in both the open and the plain-listening case, not only the
  // former.
  remoteIndicator: (
    host: string,
    port: number,
    pairingOpen: boolean,
    language: "ar" | "en",
  ): string => {
    const address = `${host}:${port}`;
    const state =
      language === "ar"
        ? pairingOpen
          ? "الإقران مفتوح"
          : "يستمع"
        : pairingOpen
          ? "pairing open"
          : "listening";
    return `${address} · ${state}`;
  },
  remoteIndicatorTitle: (connected: number, language: "ar" | "en"): string =>
    language === "ar" ? `الأجهزة المتصلة: ${connected}` : `${connected} device(s) connected`,
  remoteIndicatorIdleAt: (disableAt: number, language: "ar" | "en"): string => {
    const time = new Date(disableAt).toLocaleTimeString(language === "ar" ? "ar-EG" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return language === "ar" ? `خامل، سيتوقف عند ${time}` : `Idle, off at ${time}`;
  },
  remoteConfirmTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "طلب إقران جهاز" : "Pairing request",
  // The redesigned dialog's header subtitle, under the title — a plain
  // sentence, no name spliced in (the name has its own "Device" row below).
  remoteConfirmSubtitle: (language: "ar" | "en"): string =>
    language === "ar"
      ? "يريد جهاز الاقتران بهذا الكمبيوتر"
      : "A device wants to pair with this computer",
  // Facts-block row labels: "Device" / "From", sitting beside #remote-confirm-body
  // and #remote-confirm-from's values — no name/address spliced in.
  remoteConfirmDeviceLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "الجهاز" : "Device",
  remoteConfirmFromLabel: (language: "ar" | "en"): string => (language === "ar" ? "من" : "From"),
  // The name is spliced in by the caller (a <bdi> around a text node), never
  // baked into the sentence's own markup — see remote-status.ts's
  // withNameInBdi and remoteConfirmBodyParts below.
  remoteConfirmBody: (name: string, language: "ar" | "en"): string => {
    const { before, after } = splitOnNamePlaceholder(REMOTE_CONFIRM_BODY_TEMPLATE[language]);
    return `${before}${name}${after}`;
  },
  remoteConfirmBodyParts: (language: "ar" | "en"): { before: string; after: string } =>
    splitOnNamePlaceholder(REMOTE_CONFIRM_BODY_TEMPLATE[language]),
  // P15/D4: the connecting address, shown as a second line under the
  // phone-chosen name — a label, not a sentence, so there is nothing to
  // splice: the caller puts `address` in its own <bdi dir="ltr"> beside
  // this text, exactly like remoteConfirmBody's name.
  remoteConfirmApprove: (language: "ar" | "en"): string =>
    language === "ar" ? "موافقة" : "Approve",
  remoteConfirmDeny: (language: "ar" | "en"): string => (language === "ar" ? "رفض" : "Deny"),
  // The spec's own sentence. A token is an interactive shell on this laptop;
  // the panel admits it rather than implying a lower-privilege feature.
  remoteWarning: (language: "ar" | "en"): string =>
    language === "ar"
      ? "⚠ ما دام هذا مفعّلًا، يستطيع أي جهاز مقترن تشغيل أوامر على هذا الحاسوب باسمك وبصلاحياتك."
      : "⚠ While this is on, a paired device can run commands on this machine as you.",
  // The question every user will have, answered before they ask it.
  remoteNoCredential: (language: "ar" | "en"): string =>
    language === "ar"
      ? "لا تُستخدم أي بيانات اعتماد خاصة بـ Tailscale إطلاقًا. إن كنت تستخدمه فكل ما يفعله أنه يضيف شبكة إلى هذه القائمة، ولا يطلب جارفيس حسابًا ولا مفتاح API ولا مفتاح مصادقة."
      : "No Tailscale credential is ever involved. If you use Tailscale, all it does is add a network to this list; Jarvis never asks for an account, API key or auth key.",
  // The wire-level error codes @jarvis/remote's protocol defines
  // (REMOTE_ERROR_CODES). Sent to a phone verbatim as `err.text` — never a
  // stack, a path or a handler's own thrown message, per the spec's
  // "errors are values" rule. Kept as a closed table so a code added to the
  // protocol without a translation here is a compile error, not a runtime
  // gap that ships an English-only sentence to an Arabic-primary user.
  remoteErrorText: (code: RemoteErrorCode, language: "ar" | "en"): string => {
    const text: Record<RemoteErrorCode, { ar: string; en: string }> = {
      "bad-request": { ar: "طلب غير صالح.", en: "Invalid request." },
      "unknown-channel": { ar: "هذه القناة غير معروفة.", en: "That channel is unknown." },
      forbidden: {
        ar: "هذا الإجراء غير مسموح به من جهاز عن بُعد.",
        en: "That action is not allowed from a remote device.",
      },
      internal: { ar: "حدث خطأ داخلي.", en: "An internal error occurred." },
      "rate-limited": {
        ar: "عدد كبير جدًا من الطلبات — حاول مرة أخرى بعد قليل.",
        en: "Too many requests — try again shortly.",
      },
      unsupported: {
        ar: "هذا النوع من الطلبات غير مدعوم.",
        en: "That kind of request is not supported.",
      },
    };
    return text[code][language];
  },
  // remote:pair's three outcomes (dispatch.ts).
  remotePairingDisabled: (language: "ar" | "en"): string =>
    language === "ar" ? "الوصول عن بُعد متوقف حاليًا." : "Remote access is currently turned off.",
  remotePairingUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر بدء الإقران الآن." : "Pairing is not available right now.",
  // remote:revoke's failure (dispatch.ts) — the device store's own detail
  // never rides along; only that the revoke did not take.
  remoteRevokeFailed: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر إلغاء هذا الجهاز." : "Could not revoke that device.",
  // M11 Task 4: a remote editor:open/database:open/cluster:open whose
  // sidecar publish was refused (dispatch.ts). Three of the five reasons
  // collapse into one generic sentence — not-listening, unknown-device and
  // bad-target are never something the user on the phone can act on, only
  // something dispatch.ts's own console log (`sidecar publish refused:
  // <reason>`) is for — so the specific value never has to be translated
  // five ways for what is really only two user-facing meanings.
  sidecarProxyUnavailable: (
    reason: "off" | "needs-certificate" | "not-listening" | "unknown-device" | "bad-target",
    language: "ar" | "en",
  ): string => {
    if (reason === "off") {
      return language === "ar"
        ? "وكيل الأنفاق (sidecar proxy) متوقف من الإعدادات ← الوصول عن بُعد على هذا الحاسوب."
        : "The sidecar proxy is off in Settings → Remote access on the laptop.";
    }
    if (reason === "needs-certificate") {
      return language === "ar"
        ? "تحتاج ألسنة المحرر وقاعدة البيانات والعنقود إلى شهادة حقيقية على هذا الحاسوب (tailscale cert) — راجع الوصول عن بُعد في الإعدادات."
        : "The Editor, Database and Cluster tabs need a real certificate on the laptop (`tailscale cert`) — see Remote access in Settings.";
    }
    return language === "ar"
      ? "تعذّر على هذا الحاسوب فتح هذا التبويب عن بُعد."
      : "The laptop could not open this tab remotely.";
  },
  // Settings' certificate-state note, under the sidecar proxy toggle (Task
  // 4 rule 5) — said to the person who can fix it, the same fact
  // sidecarProxyUnavailable's "needs-certificate" text names to a phone.
  remoteCertificateReal: (hostname: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `✓ شهادة حقيقية لـ ${hostname} — المحرر وقاعدة البيانات والعنقود متاحة على الهاتف.`
      : `✓ Real certificate for ${hostname} — Editor, Database and Cluster available on the phone.`,
  remoteCertificateSelfSigned: (language: "ar" | "en"): string =>
    language === "ar"
      ? "شهادة موقّعة ذاتيًا — المحرر وقاعدة البيانات والعنقود غير متاحة على الهاتف. شهادة حقيقية تأتي من tailscale cert؛ راجع الوصول عن بُعد في الوثائق."
      : "Self-signed certificate — Editor, Database and Cluster are not available on the phone. A real one comes from `tailscale cert`; see Remote access in the docs.",
  remoteProxyNeedsCertificate: (language: "ar" | "en"): string =>
    language === "ar"
      ? "وكيل الأنفاق مفعّل، لكن الشهادة موقّعة ذاتيًا أو بلا اسم DNS — تبقى تلك الألسنة غير متاحة حتى إعداد شهادة حقيقية."
      : "Sidecar proxy is on, but the certificate is self-signed or has no DNS name — those tabs stay unavailable until a real certificate is configured.",

  // The "Get certificate from Tailscale" row, under the sidecar proxy
  // switch — remote:tailscaleCert's own status/action text (settings.ts,
  // dispatch.ts). remoteCertNamed/-Path read from `draft.remote.tls`, never
  // from the bridge's own live status (unlike remoteCertificateReal/
  // SelfSigned above, which describe what is actually being served).
  remoteCertNone: (language: "ar" | "en"): string =>
    language === "ar" ? "الشهادة: لا شيء" : "Certificate: none",
  remoteCertNamed: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `الشهادة: ${name} (من Tailscale)` : `Certificate: ${name} (from Tailscale)`,
  remoteCertPath: (path: string, language: "ar" | "en"): string =>
    language === "ar" ? `الشهادة: ${path}` : `Certificate: ${path}`,
  remoteCertGetButton: (language: "ar" | "en"): string =>
    language === "ar" ? "احصل على شهادة من Tailscale" : "Get certificate from Tailscale",
  remoteCertRenewButton: (language: "ar" | "en"): string => (language === "ar" ? "تجديد" : "Renew"),
  remoteCertBusy: (mode: "get" | "renew", language: "ar" | "en"): string => {
    if (mode === "renew") {
      return language === "ar" ? "جارٍ التجديد…" : "Renewing…";
    }
    return language === "ar" ? "جارٍ الحصول على الشهادة…" : "Getting certificate…";
  },
  // remote:tailscaleCert's "no-tailscale"/"not-connected" outcomes.
  remoteCertNoTailscale: (language: "ar" | "en"): string =>
    language === "ar" ? "ثبّت Tailscale على هذا الحاسوب." : "Install Tailscale on this Mac.",
  remoteCertNotConnected: (language: "ar" | "en"): string =>
    language === "ar" ? "اتصل بـ Tailscale أولًا." : "Connect Tailscale first.",
  // The "https-disabled" outcome: the middle piece becomes a clickable
  // control (settings.ts) that opens the admin console through the same
  // existing external-link path every other in-app link uses
  // (window.jarvis.openTab against the reserved personal-browser project) —
  // never window.open, which the main window's own webContents denies
  // outright (main.ts's setWindowOpenHandler).
  remoteCertHttpsDisabled: (
    language: "ar" | "en",
  ): { before: string; link: string; after: string } =>
    language === "ar"
      ? {
          before: "فعّل شهادات HTTPS في ",
          link: "لوحة تحكم Tailscale",
          after: " (DNS ← شهادات HTTPS)، ثم حاول مرة أخرى.",
        }
      : {
          before: "Turn on HTTPS certificates in your ",
          link: "Tailscale admin console",
          after: " (DNS → HTTPS Certificates), then try again.",
        },
  // Any other failure — `detail` (the CLI's own last line) rides alongside
  // this, the same settingsSaveFailed pattern.
  remoteCertFailed: (language: "ar" | "en"): string =>
    language === "ar"
      ? "تعذّر الحصول على شهادة — التفاصيل أدناه."
      : "Couldn't get a certificate — see below.",
  // The one-line hint under the sidecar proxy switch when bindAddress is
  // already a Tailscale (mesh) address but no certificate is configured yet
  // — shown regardless of whether the proxy switch itself is on, since the
  // switch alone does nothing for those tabs without a certificate either way.
  remoteCertHint: (language: "ar" | "en"): string =>
    language === "ar"
      ? "يحتاج المحرر وقاعدة البيانات والعنقود على الهاتف إلى شهادة — احصل على واحدة من Tailscale."
      : "The phone's Editor, Database and Cluster need a certificate — get one from Tailscale.",

  // M10 Task 3: the push notification catalogue — the only text a
  // notification's title/body carry, built in the *device's* registered
  // language (never the app's own PRIMARY_LANGUAGE unless that's the
  // fallback). `pushTitle`/`pushBody` never see a session summary, a
  // command, a path, a device name or a token: `pushBody`'s only
  // interpolated value is the project name (session-* kinds only, and only
  // when the caller passed one — notify.ts gates that on
  // remote.push.includeProjectNames before calling), and command-finished's
  // `detail` carries only a rounded minute count and a boolean, never the
  // command that ran.
  pushTitle: (language: "ar" | "en"): string => (language === "ar" ? "جارفيس" : "Jarvis"),
  pushBody: (
    kind: PushKind,
    project: string | undefined,
    language: "ar" | "en",
    detail?: { ok: boolean; seconds: number },
  ): string => {
    switch (kind) {
      case "session-done":
        return language === "ar"
          ? project
            ? `انتهت جلسة ${project}.`
            : "انتهت جلستك."
          : project
            ? `${project} is done.`
            : "Your session is done.";
      case "session-failed":
        return language === "ar"
          ? project
            ? `فشلت جلسة ${project}.`
            : "فشلت جلستك."
          : project
            ? `${project} failed.`
            : "Your session failed.";
      case "session-waiting":
        return language === "ar"
          ? project
            ? `جلسة ${project} تنتظر ردّك.`
            : "جلستك تنتظر ردّك."
          : project
            ? `${project} is waiting for you.`
            : "Your session is waiting for you.";
      case "command-finished": {
        // No detail: a neutral line, never a fabricated duration or
        // outcome — "about 1 min — succeeded" when nothing of the kind was
        // actually known would be a lie, not a default.
        if (detail === undefined) {
          return language === "ar" ? "انتهى تنفيذ أمر." : "A command finished.";
        }
        // Minimum 1 minute, rounded to the nearest — never the raw seconds
        // and never the command that ran.
        const minutes = Math.max(1, Math.round(detail.seconds / 60));
        const succeeded = detail.ok;
        return language === "ar"
          ? `انتهى تنفيذ أمر (نحو ${minutes} د) — ${succeeded ? "نجح" : "فشل"}.`
          : `A command finished (about ${minutes} min) — ${succeeded ? "succeeded" : "failed"}.`;
      }
      case "reply":
        return language === "ar" ? "ردّ جارفيس على رسالتك." : "Jarvis replied to your message.";
    }
  },
  // The only `registered: false` text the laptop ever sends (PushRegisterResult,
  // @jarvis/wire's push.ts) — the phone builds every other registration line
  // (laptop off, pending, denied…) from its own i18n table plus the boolean
  // `laptopEnabled`.
  pushRegisterInvalid: (language: "ar" | "en"): string =>
    language === "ar"
      ? "تعذّر تسجيل هذا الجهاز لتلقّي الإشعارات"
      : "This device could not be registered for notifications",
};

// NOT the same table as arabicSessionsCount below, even though the two
// started out identical (that copy-paste is exactly the bug this comment
// exists to prevent someone re-introducing). The two counted nouns sit in
// grammatically different positions:
//   - arabicSessionsCount's output is a standalone label value ("عدد
//     الجلسات: جلستان") — a bare counted noun, nominative, same as it would
//     be as the subject of a sentence.
//   - arabicFilesCount's output is always the mudaf ilayhi of "حفظ" (an
//     iḍāfa: "حفظ ملفين" = "the committing of two files"), which the masdar
//     "حفظ" governs into the *genitive* — not nominative.
// That only actually shows up at count === 2, where the genitive dual
// (ملفين) differs in spelling from the nominative dual (ملفان) that
// arabicSessionsCount's shape would produce. Every other count (1, 3-10,
// 11+) is spelled the same in both cases once diacritics are dropped, which
// is exactly how the wrong table went unnoticed here. If this file's
// counted noun ever needs to appear standalone too, give it its own
// function rather than reusing this one — don't merge the two tables back
// together.
function arabicFilesCount(count: number): string {
  if (count === 1) return "ملف واحد";
  if (count === 2) return "ملفين"; // genitive dual (not ملفان — see comment above)
  if (count <= 10) return `${count} ملفات`;
  return `${count} ملفًا`;
}

function arabicSessionsCount(count: number): string {
  if (count === 0) return "لا جلسات";
  if (count === 1) return "جلسة واحدة";
  if (count === 2) return "جلستان";
  if (count <= 10) return `${count} جلسات`;
  return `${count} جلسة`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this is a Wayland session.
 *
 * Only used to explain a failed globalShortcut registration, which is why it
 * takes the environment rather than reading it: the message that comes out is
 * a user-visible string, and messages.test.ts asserts both branches.
 *
 * Both variables are checked because neither is universal — XDG_SESSION_TYPE
 * is set by the login manager and missing under some, while WAYLAND_DISPLAY is
 * set by the compositor and missing when an app runs through XWayland (where
 * the shortcut does in fact work, and this correctly says so).
 */
export function isWayland(env: NodeJS.ProcessEnv): boolean {
  if (env["XDG_SESSION_TYPE"] === "wayland") return true;
  const display = env["WAYLAND_DISPLAY"];
  return display !== undefined && display !== "";
}

/** Arabic counts tools with the same singular/dual/plural split
 *  arabicFilesCount and arabicSessionsCount already handle for their nouns —
 *  see the conventions doc on why these are separate tables that look alike. */
function arabicToolsCount(count: number): string {
  if (count === 1) return "أداة واحدة";
  if (count === 2) return "أداتين";
  if (count >= 3 && count <= 10) return `${count} أدوات`;
  return `${count} أداة`;
}

/** What each prerequisite is called, and the one line saying why anyone would
 *  want it. Kept beside the other bilingual strings rather than in the
 *  catalogue, so a tool cannot gain an entry without gaining both languages. */
const PREREQUISITE_TEXT: Record<
  PrerequisiteId,
  { en: { name: string; unlocks: string }; ar: { name: string; unlocks: string } }
> = {
  agent: {
    en: { name: "Claude Code", unlocks: "Sessions — the point of the app" },
    ar: { name: "Claude Code", unlocks: "الجلسات — وهي جوهر التطبيق" },
  },
  ffmpeg: {
    en: { name: "ffmpeg", unlocks: "Recording your voice" },
    ar: { name: "ffmpeg", unlocks: "تسجيل صوتك" },
  },
  player: {
    en: { name: "An audio player", unlocks: "Hearing replies out loud" },
    ar: { name: "مشغّل صوت", unlocks: "سماع الردود بصوت مسموع" },
  },
  whisper: {
    en: { name: "whisper.cpp", unlocks: "Turning what you said into text" },
    ar: { name: "whisper.cpp", unlocks: "تحويل ما تقوله إلى نص" },
  },
  piper: {
    en: { name: "Piper", unlocks: "The voice that speaks replies" },
    ar: { name: "Piper", unlocks: "الصوت الذي ينطق الردود" },
  },
  "voice-en": {
    en: { name: "English voice", unlocks: "Spoken replies in English" },
    ar: { name: "صوت إنجليزي", unlocks: "ردود منطوقة بالإنجليزية" },
  },
  "voice-ar": {
    en: { name: "Arabic voice", unlocks: "Spoken replies in Arabic" },
    ar: { name: "صوت عربي", unlocks: "ردود منطوقة بالعربية" },
  },
  "code-server": {
    en: { name: "code-server", unlocks: "The Editor tab" },
    ar: { name: "code-server", unlocks: "تبويب المحرر" },
  },
  dbgate: {
    en: { name: "DbGate", unlocks: "The Database tab" },
    ar: { name: "DbGate", unlocks: "تبويب قواعد البيانات" },
  },
  headlamp: {
    en: { name: "Headlamp", unlocks: "The Cluster tab" },
    ar: { name: "Headlamp", unlocks: "تبويب العناقيد" },
  },
  docker: {
    en: { name: "Docker", unlocks: "The Docker tab" },
    ar: { name: "Docker", unlocks: "تبويب Docker" },
  },
  kubectl: {
    en: { name: "kubectl", unlocks: "Not needed by Jarvis; reported if present" },
    ar: { name: "kubectl", unlocks: "لا يحتاجه جارفيس؛ يُعرض إن كان موجودًا" },
  },
};
