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
export const PRIMARY_LANGUAGE = "en";

export const MESSAGES = {
  hotkeyCollision: (combo: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر تسجيل اختصار ${combo} — يبدو أن تطبيقًا آخر يستخدمه بالفعل.`
      : `Could not register the ${combo} shortcut — another app is probably already using it.`,
  recordingFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر تسجيل الصوت: ${message}`
      : `Recording failed: ${message}`,
  transcriptionFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `فشل تحويل الصوت إلى نص: ${message}`
      : `Transcription failed: ${message}`,
  // The renderer's history-panel badge (`${n} sessions`) — pulled through
  // here rather than left as an inline English template literal both for
  // the language-in/string-out pattern above and because English's
  // one/many split ("1 session" vs "2 sessions") doesn't carry over to
  // Arabic: MSA counted nouns have distinct singular (1), dual (2),
  // plural (3-10), and a reversion to singular for 11+.
  sessionsCount: (count: number, language: "ar" | "en"): string =>
    language === "ar" ? arabicSessionsCount(count) : `${count} ${count === 1 ? "session" : "sessions"}`,
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
  dockerHeading: (language: "ar" | "en"): string =>
    language === "ar" ? "الحاويات" : "Containers",
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
    language === "ar" ? "لا توجد عناقيد مُعرَّفة لهذا المشروع." : "No clusters configured for this project.",
  // Follows noClustersConfigured exactly, and for the same reason: a chat
  // is not rooted in a directory either, so the personal browser's own
  // explanation would be the wrong one here.
  noChatConfigured: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد محادثات مُعرَّفة لهذا المشروع." : "No chat configured for this project.",
  // DbGate has no bind-address option and always listens on 0.0.0.0, so
  // every instance is guarded by a login generated at spawn. This is how
  // the user learns it; both halves are opaque technical tokens and stay
  // LTR in either language.
  databaseLogin: (login: string, password: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `الدخول: ${login} · كلمة المرور: ${password}`
      : `login ${login} · password ${password}`,
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
  apiNewRequest: (language: "ar" | "en"): string => (language === "ar" ? "طلب جديد" : "New request"),
  apiNewFolder: (language: "ar" | "en"): string => (language === "ar" ? "مجلد جديد" : "New folder"),
  apiNewCollection: (language: "ar" | "en"): string =>
    language === "ar" ? "مجموعة جديدة" : "New collection",
  apiImport: (language: "ar" | "en"): string =>
    language === "ar" ? "استيراد من Postman" : "Import from Postman",
  apiRename: (language: "ar" | "en"): string => (language === "ar" ? "إعادة تسمية" : "Rename"),
  apiDelete: (language: "ar" | "en"): string => (language === "ar" ? "حذف" : "Delete"),
  apiConfirmDelete: (name: string, language: "ar" | "en"): string =>
    language === "ar" ? `حذف ${name}؟` : `Delete ${name}?`,
  apiCopyCurl: (language: "ar" | "en"): string => (language === "ar" ? "نسخ كـ cURL" : "Copy as cURL"),
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
    language === "ar" ? "إظهار أو إخفاء شريط العلامات الجانبي" : "Show or hide the bookmarks sidebar",
  unknownProject: (language: "ar" | "en"): string =>
    language === "ar" ? "لا أعرف مشروعًا بهذا الاسم." : "I don't know a project by that name.",
  // The personal browser's name in the project selector. Its *key* is the
  // reserved "__personal__" (see personal.ts) — never shown; this is what
  // the user reads, beside project names they chose themselves.
  personalProject: (language: "ar" | "en"): string =>
    language === "ar" ? "شخصي" : "Personal",
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
  // Settings' save flow. The headline is bilingual per the Global
  // Constraint every other view follows; parseConfig's own thrown message
  // (English, developer-facing — e.g. "Config `agents.x.command` must be a
  // string") is shown underneath it verbatim, the same headline-plus-
  // technical-detail split the Changes view and Providers panel already use.
  settingsSaveFailed: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّر حفظ الإعدادات — التفاصيل أدناه." : "Couldn't save settings — see below.",
  settingsSaved: (language: "ar" | "en"): string => (language === "ar" ? "تم الحفظ." : "Saved."),
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
  sideBySideLabel: (language: "ar" | "en"): string => (language === "ar" ? "جنبًا إلى جنب" : "Side by side"),
  unifiedLabel: (language: "ar" | "en"): string => (language === "ar" ? "موحّد" : "Unified"),
  beforeColumnLabel: (language: "ar" | "en"): string => (language === "ar" ? "قبل" : "BEFORE"),
  afterColumnLabel: (language: "ar" | "en"): string => (language === "ar" ? "بعد" : "AFTER"),
  testsGroupLabel: (language: "ar" | "en"): string => (language === "ar" ? "الاختبارات" : "TESTS"),
  commitMessagePlaceholder: (language: "ar" | "en"): string =>
    language === "ar" ? "رسالة الحفظ…" : "Commit message…",
  stageFileLabel: (language: "ar" | "en"): string => (language === "ar" ? "تجهيز الملف" : "Stage file"),
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
  capacityLeftLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "المتبقي" : "LEFT",
  // Three different facts, never collapsed into one "unknown".
  capacityUnsupported: (language: "ar" | "en"): string =>
    language === "ar" ? "لا يوفّر قراءة للسعة" : "no capacity reading available",
  capacityUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّرت قراءة السعة" : "capacity couldn't be read",
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
