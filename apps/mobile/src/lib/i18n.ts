// Every string the app itself shows comes from here — ar and en, both
// non-empty, ar != en for every key (see i18n.test.ts). Server-originated
// text (err.text, project names, session titles) is never routed through
// this table: it is displayed verbatim.

export type Language = "ar" | "en";

export const STRINGS = {
  "app.title": {
    en: "Jarvis",
    ar: "جارفيس",
  },
  "nav.dashboard": {
    en: "Dashboard",
    ar: "لوحة التحكم",
  },
  "nav.settings": {
    en: "Settings",
    ar: "الإعدادات",
  },
  "nav.sessions": {
    en: "Sessions",
    ar: "الجلسات",
  },
  "nav.voice": { en: "Voice", ar: "الصوت" },
  "nav.workspace": { en: "Workspace", ar: "مساحة العمل" },
  "conn.connected": { en: "Connected", ar: "متصل" },
  "sessions.today": { en: "TODAY", ar: "اليوم" },
  "sessions.yesterday": { en: "YESTERDAY", ar: "أمس" },
  "voice.readAloud": { en: "Read aloud", ar: "قراءة بصوت عالٍ" },
  "common.back": { en: "Back", ar: "رجوع" },
  "pair.title": {
    en: "Pair with your computer",
    ar: "الاقتران بجهاز الكمبيوتر",
  },
  "dashboard.title": {
    en: "Dashboard",
    ar: "لوحة التحكم",
  },
  "settings.title": {
    en: "Settings",
    ar: "الإعدادات",
  },
  "settings.language": {
    en: "Language",
    ar: "اللغة",
  },
  "settings.language.ar": {
    en: "Arabic",
    ar: "العربية",
  },
  "settings.language.en": {
    en: "English",
    ar: "الإنجليزية",
  },
  "settings.restartToApply": {
    en: "Restart {app} to apply {language}.",
    ar: "أعد تشغيل {app} لتطبيق {language}.",
  },
  "settings.pairedLaptop": {
    en: "Paired computer",
    ar: "الكمبيوتر المقترن",
  },
  "settings.address": {
    en: "Address: {value}",
    ar: "العنوان: {value}",
  },
  "settings.fingerprintTail": {
    en: "Certificate ends in …{tail}",
    ar: "الشهادة تنتهي بـ …{tail}",
  },
  "settings.deviceId": {
    en: "Device ID: {value}",
    ar: "معرّف الجهاز: {value}",
  },
  "settings.pairedAt": {
    en: "Paired on {date}",
    ar: "تم الاقتران في {date}",
  },
  "settings.unpair": {
    en: "Unpair this phone",
    ar: "إلغاء اقتران هذا الهاتف",
  },
  "settings.unpairConfirm": {
    en: "Remove this pairing from this phone? You'll need to scan a new QR code to pair again. To fully revoke access, also remove this device in the computer's Settings.",
    ar: "هل تريد إزالة هذا الاقتران من هذا الهاتف؟ ستحتاج إلى مسح رمز QR جديد للاقتران مرة أخرى. لإلغاء الوصول بالكامل، احذف هذا الجهاز أيضًا من إعدادات الكمبيوتر.",
  },
  "settings.connection": {
    en: "Connection",
    ar: "الاتصال",
  },
  "settings.lastFrame": {
    en: "Last data {seconds}s ago",
    ar: "آخر بيانات منذ {seconds} ثانية",
  },
  "settings.reconnect": {
    en: "Reconnect",
    ar: "إعادة الاتصال",
  },
  "settings.connected": {
    en: "Connected",
    ar: "متصل",
  },
  "settings.appVersion": {
    en: "App version {version}",
    ar: "إصدار التطبيق {version}",
  },
  "settings.notPaired": {
    en: "Not paired.",
    ar: "غير مقترن.",
  },
  "settings.unpairFailed": {
    en: "Couldn't unpair this phone. Try again.",
    ar: "تعذّر إلغاء اقتران هذا الهاتف. حاول مرة أخرى.",
  },
  "settings.reconnectFailed": {
    en: "Couldn't reconnect. Try again.",
    ar: "تعذّرت إعادة الاتصال. حاول مرة أخرى.",
  },
  // M10 Task 6: the Notifications switch and its status line
  // (task-6-brief.md, i18n keys). Server-originated text (a registration
  // failure's own explanation) is never routed through this table — see
  // this file's header comment.
  "settings.notifications": {
    en: "Notifications",
    ar: "الإشعارات",
  },
  "settings.notificationsHint": {
    en: "Tell this phone when an agent finishes or is waiting for you. Nothing from the terminal is ever sent.",
    ar: "أخبر هذا الهاتف عندما ينتهي وكيل أو ينتظرك. لا يُرسل أي شيء من الطرفية أبدًا.",
  },
  "settings.notifications.requesting": {
    en: "Requesting permission…",
    ar: "جارٍ طلب الإذن…",
  },
  "settings.notifications.on": {
    en: "On",
    ar: "مفعّلة",
  },
  "settings.notifications.laptopOff": {
    en: "On, but turned off on the laptop — Settings → Remote access → push notifications",
    ar: "مفعّلة، لكنها معطّلة على الكمبيوتر — الإعدادات ← الوصول عن بُعد ← الإشعارات",
  },
  "settings.notifications.denied": {
    en: "Permission denied",
    ar: "تم رفض الإذن",
  },
  "settings.notifications.blocked": {
    en: "Blocked in system settings",
    ar: "محظورة في إعدادات النظام",
  },
  "settings.notifications.unavailable": {
    en: "Not available on this device or build",
    ar: "غير متاحة على هذا الجهاز أو هذا الإصدار",
  },
  // iOS sideloaded builds (AltStore/SideStore/personal-team Xcode): free
  // signing strips the push entitlement, so the token fetch always fails.
  // Named explicitly so users don't chase a bug that isn't one.
  "settings.notifications.sideloaded": {
    en: "Not available on sideloaded iOS builds — free signing has no push permission. Everything else works.",
    ar: "غير متاحة في إصدارات iOS المثبّتة جانبيًا — التوقيع المجاني لا يدعم إشعارات الدفع. كل شيء آخر يعمل.",
  },
  "settings.notifications.pending": {
    en: "Will register when connected",
    ar: "ستُسجَّل عند الاتصال",
  },
  "settings.notifications.error": {
    en: "Couldn't register for notifications",
    ar: "تعذّر التسجيل للإشعارات",
  },
  "settings.notifications.openSettings": {
    en: "Open Settings",
    ar: "فتح الإعدادات",
  },
  "notifications.channelName": {
    en: "Jarvis",
    ar: "جارفيس",
  },
  // Free-signing plan, work item 3: sideloaded iOS builds die 7 days after
  // signing. Banner under 2 days; local notification a day before.
  "expiry.banner": {
    en: "This build expires in {days} day(s). Refresh it with AltStore or SideStore.",
    ar: "تنتهي صلاحية هذا الإصدار خلال {days} يوم/أيام. حدّثه عبر AltStore أو SideStore.",
  },
  "expiry.notification.title": {
    en: "Jarvis expires tomorrow",
    ar: "تنتهي صلاحية Jarvis غدًا",
  },
  "expiry.notification.body": {
    en: "Sideloaded builds stop opening after 7 days. Refresh with AltStore or SideStore to keep it running.",
    ar: "الإصدارات المثبّتة جانبيًا تتوقف عن الفتح بعد 7 أيام. حدّثه عبر AltStore أو SideStore ليستمر في العمل.",
  },
  "common.retry": {
    en: "Retry",
    ar: "إعادة المحاولة",
  },
  "common.cancel": {
    en: "Cancel",
    ar: "إلغاء",
  },
  "common.ok": {
    en: "OK",
    ar: "موافق",
  },
  // Fix round 1 (Important 3): a shared fallback for any screen's
  // `failed`/`stale` state that has no server text to show verbatim
  // (a timeout or offline refusal carries none) — used by Changes,
  // History and the transcript route instead of leaving the screen blank
  // or showing a misleading empty-state copy.
  "common.loadFailed": {
    en: "Couldn't load. Try again.",
    ar: "تعذّر التحميل. حاول مرة أخرى.",
  },
  "common.stale": {
    en: "This may be out of date.",
    ar: "قد تكون هذه البيانات قديمة.",
  },
  "pair.scan": {
    en: "Scan the QR code shown by the desktop app",
    ar: "امسح رمز QR الظاهر في تطبيق سطح المكتب",
  },
  "pair.pasteLink": {
    en: "Or paste the pairing link",
    ar: "أو الصق رابط الاقتران",
  },
  "pair.linkInvalid": {
    en: "That link isn't a valid pairing link.",
    ar: "هذا الرابط ليس رابط اقتران صالحًا.",
  },
  "pair.deviceName": {
    en: "Device name",
    ar: "اسم الجهاز",
  },
  "pair.hostNeeded": {
    en: "Enter your computer's address on the network",
    ar: "أدخل عنوان جهاز الكمبيوتر على الشبكة",
  },
  "pair.hostInvalid": {
    en: "That's not a valid network address.",
    ar: "هذا ليس عنوان شبكة صالحًا.",
  },
  "pair.waitingApproval": {
    en: "Waiting for approval on your computer…",
    ar: "بانتظار الموافقة على جهاز الكمبيوتر…",
  },
  "pair.denied": {
    en: "Pairing was denied on the computer.",
    ar: "تم رفض الاقتران على جهاز الكمبيوتر.",
  },
  "pair.expired": {
    en: "Expired or wrong code — make a new one on the computer.",
    ar: "انتهت الصلاحية أو الرمز غير صحيح — أنشئ رمزًا جديدًا على الكمبيوتر.",
  },
  "pair.fingerprintMismatch": {
    en: "The computer's certificate didn't match the code — make a new code and try again. If this keeps happening, someone may be intercepting the connection.",
    ar: "شهادة الكمبيوتر لا تطابق الرمز — أنشئ رمزًا جديدًا وحاول مرة أخرى. إذا تكرر ذلك، فقد يكون هناك من يتنصت على الاتصال.",
  },
  "pair.unreachable": {
    en: "Couldn't reach the computer. Check you're on the same network.",
    ar: "تعذّر الوصول إلى الكمبيوتر. تأكد من أنك على نفس الشبكة.",
  },
  "pair.success": {
    en: "Paired successfully",
    ar: "تم الاقتران بنجاح",
  },
  "pair.cameraPermission": {
    en: "Camera access is needed to scan the QR code.",
    ar: "الوصول إلى الكاميرا مطلوب لمسح رمز QR.",
  },
  "pair.alreadyPaired": {
    en: "This phone is already paired. Unpair in Settings first.",
    ar: "هذا الهاتف مقترن بالفعل. ألغِ الاقتران من الإعدادات أولًا.",
  },
  "pair.confirm": {
    en: "Pair with {host}:{port}? Certificate ends in …{tail}.",
    ar: "الاقتران بـ {host}:{port}؟ الشهادة تنتهي بـ …{tail}.",
  },
  "pair.confirmName": {
    en: "Computer name: {name}",
    ar: "اسم الكمبيوتر: {name}",
  },
  "pair.trustSystem": {
    en: "Trusts the certificate through the phone's own trust store (Tailscale)",
    ar: "يثق بالشهادة عبر مخزن الثقة الخاص بالهاتف (Tailscale)",
  },
  "pair.trustPinned": {
    en: "Pins the laptop's certificate fingerprint",
    ar: "يثبّت بصمة شهادة الكمبيوتر المحمول",
  },
  "pair.timeout": {
    en: "No approval arrived in time — make a new code on the laptop.",
    ar: "لم تصل الموافقة في الوقت المحدد — أنشئ رمزًا جديدًا على الكمبيوتر.",
  },
  "pair.protocol": {
    en: "The laptop answered in a way this app doesn't understand — update Jarvis on both.",
    ar: "أجاب الكمبيوتر بطريقة لا يفهمها هذا التطبيق — حدّث Jarvis على الجهازين.",
  },
  "pair.saveFailed": {
    en: "Couldn't save the pairing on this phone. Try again.",
    ar: "تعذّر حفظ الاقتران على هذا الهاتف. حاول مرة أخرى.",
  },
  "pair.checkFailed": {
    en: "Couldn't check whether this phone is already paired. Try again.",
    ar: "تعذّر التحقق مما إذا كان هذا الهاتف مقترنًا بالفعل. حاول مرة أخرى.",
  },
  "pair.confirmButton": {
    en: "Pair",
    ar: "اقتران",
  },
  "pair.clearFailed": {
    en: "Couldn't remove the old pairing from this phone.",
    ar: "تعذّرت إزالة الاقتران القديم من هذا الهاتف.",
  },
  "conn.connecting": {
    en: "Connecting…",
    ar: "جارٍ الاتصال…",
  },
  "conn.reconnecting": {
    en: "Reconnecting…",
    ar: "جارٍ إعادة الاتصال…",
  },
  "conn.stale": {
    en: "Connection may be stale — no data recently.",
    ar: "قد يكون الاتصال غير محدث — لا توجد بيانات جديدة مؤخرًا.",
  },
  "conn.offline": {
    en: "Offline. Tap to retry.",
    ar: "غير متصل. اضغط لإعادة المحاولة.",
  },
  "conn.unpaired": {
    en: "This phone was unpaired.",
    ar: "تم إلغاء اقتران هذا الهاتف.",
  },
  "conn.incompatible": {
    en: "Update Jarvis on this phone and your computer to keep them in sync.",
    ar: "حدّث Jarvis على هذا الهاتف وجهاز الكمبيوتر لإبقائهما متزامنين.",
  },
  "conn.pinMismatch": {
    en: "The computer's certificate doesn't match the one this phone paired with. If you didn't change the computer, someone may be intercepting the connection. Tap \"Pair again\" if this continues.",
    ar: 'شهادة الكمبيوتر لا تطابق الشهادة التي اقترن بها هذا الهاتف. إذا لم تُغيّر جهاز الكمبيوتر، فقد يكون هناك من يتنصت على الاتصال. اضغط "إعادة الاقتران" إذا استمر ذلك.',
  },
  "conn.pairAgain": {
    en: "Pair again",
    ar: "إعادة الاقتران",
  },
  "conn.pairAgainConfirmTitle": {
    en: "Pair again?",
    ar: "إعادة الاقتران؟",
  },
  "conn.pairAgainConfirmBody": {
    en: "This removes the pairing from this phone. You'll need to scan a new QR code to pair again. The computer keeps this device listed until you also remove it in its Settings.",
    ar: "سيؤدي هذا إلى إزالة الاقتران من هذا الهاتف. ستحتاج إلى مسح رمز QR جديد للاقتران مرة أخرى. سيظل الكمبيوتر يدرج هذا الجهاز حتى تحذفه أيضًا من إعداداته.",
  },
  "dashboard.projects": {
    en: "Projects",
    ar: "المشاريع",
  },
  "dashboard.noProjects": {
    en: "No projects configured.",
    ar: "لا توجد مشاريع معدة.",
  },
  "dashboard.sessions": {
    en: "Sessions",
    ar: "الجلسات",
  },
  "dashboard.noSessions": {
    en: "No sessions running.",
    ar: "لا توجد جلسات قيد التشغيل.",
  },
  "dashboard.system": {
    en: "System",
    ar: "النظام",
  },
  "metric.cpu": {
    en: "CPU",
    ar: "المعالج",
  },
  "metric.memory": {
    en: "Memory",
    ar: "الذاكرة",
  },
  "metric.disk": {
    en: "Disk",
    ar: "التخزين",
  },
  "metric.network": {
    en: "Network",
    ar: "الشبكة",
  },
  "metric.uptime": {
    en: "Uptime",
    ar: "مدة التشغيل",
  },
  "metric.temperature": {
    en: "Temperature",
    ar: "الحرارة",
  },
  "metric.unavailable": {
    en: "Not available",
    ar: "غير متوفر",
  },
  "dashboard.allSessions": {
    en: "All sessions",
    ar: "كل الجلسات",
  },
  "sessions.title": {
    en: "Sessions",
    ar: "الجلسات",
  },
  "sessions.active": {
    en: "Active",
    ar: "نشطة",
  },
  "sessions.ended": {
    en: "Ended",
    ar: "منتهية",
  },
  "sessions.none": {
    en: "No sessions.",
    ar: "لا توجد جلسات.",
  },
  "sessions.state.starting": {
    en: "Starting",
    ar: "قيد البدء",
  },
  "sessions.state.running": {
    en: "Running",
    ar: "قيد التشغيل",
  },
  "sessions.state.waiting": {
    en: "Waiting",
    ar: "بالانتظار",
  },
  "sessions.state.done": {
    en: "Done",
    ar: "منتهية",
  },
  "sessions.state.dead": {
    en: "Stopped",
    ar: "متوقفة",
  },
  // A row process-scan.ts (the laptop's own scan) found running outside
  // Jarvis — the same chip desktop's Sessions view shows.
  "sessions.external": {
    en: "outside Jarvis",
    ar: "خارج جارفيس",
  },
  "session.notFound": { en: "Session not found.", ar: "الجلسة غير موجودة." },
  "session.ended": { en: "This session has ended.", ar: "انتهت هذه الجلسة." },
  "session.attaching": { en: "Loading terminal…", ar: "جارٍ تحميل الطرفية…" },
  "session.waiting": { en: "Waiting for the connection…", ar: "بانتظار الاتصال…" },
  "session.listFailed": {
    en: "Couldn't load sessions. Try again.",
    ar: "تعذّر تحميل الجلسات. حاول مرة أخرى.",
  },
  "session.attachFailed": {
    en: "Could not load the terminal. Retry.",
    ar: "تعذّر تحميل الطرفية. أعد المحاولة.",
  },
  "session.trimmed": { en: "Output trimmed: {amount}", ar: "تم اقتطاع المخرجات: {amount}" },
  "session.sendText": { en: "Send text", ar: "إرسال النص" },
  "session.composePlaceholder": {
    en: "Type text; use ⏎ to submit",
    ar: "اكتب النص؛ استخدم ⏎ للتنفيذ",
  },
  "session.offline": { en: "Not sent: phone is disconnected.", ar: "لم يُرسل: الهاتف غير متصل." },
  "session.uncertain": {
    en: "Connection lost; the text may have been sent. Check before trying again.",
    ar: "فُقد الاتصال؛ ربما أُرسل النص. تحقق قبل المحاولة مجددًا.",
  },
  "session.rateLimited": {
    en: "Too many requests. Try again shortly.",
    ar: "طلبات كثيرة جدًا. حاول بعد قليل.",
  },
  "session.tooLong": { en: "Text is too long.", ar: "النص طويل جدًا." },
  "session.ctrlInvalid": {
    en: "Ctrl needs one letter or control character.",
    ar: "يتطلب Ctrl حرفًا واحدًا صالحًا.",
  },
  "session.ctrlArmed": {
    en: "Ctrl is armed for the next character.",
    ar: "Ctrl مفعّل للحرف التالي.",
  },
  "key.esc": { en: "Escape", ar: "إلغاء" },
  "key.tab": { en: "Tab", ar: "جدولة" },
  "key.shiftTab": { en: "Shift Tab", ar: "جدولة عكسية" },
  "key.ctrl": { en: "Control", ar: "تحكم" },
  "key.ctrlC": { en: "Interrupt", ar: "مقاطعة" },
  "key.left": { en: "Left arrow", ar: "سهم لليسار" },
  "key.up": { en: "Up arrow", ar: "سهم للأعلى" },
  "key.down": { en: "Down arrow", ar: "سهم للأسفل" },
  "key.right": { en: "Right arrow", ar: "سهم لليمين" },
  "key.backspace": { en: "Backspace", ar: "حذف الحرف السابق" },
  "key.enter": { en: "Enter", ar: "إدخال" },
  "dashboard.voice": { en: "Voice", ar: "الصوت" },
  "dashboard.changes": { en: "Changes", ar: "التغييرات" },
  "dashboard.history": { en: "History", ar: "السجل" },
  "dashboard.workspace": { en: "Workspace", ar: "مساحة العمل" },
  "changes.title": { en: "Changes", ar: "التغييرات" },
  "changes.sessions": { en: "Session", ar: "الجلسة" },
  "changes.noSessions": { en: "No sessions yet.", ar: "لا توجد جلسات بعد." },
  "changes.loading": { en: "Loading changes…", ar: "جارٍ تحميل التغييرات…" },
  "changes.endedWarning": {
    en: "This session has ended. These are the current working tree changes.",
    ar: "انتهت هذه الجلسة. هذه تغييرات شجرة العمل الحالية.",
  },
  "changes.uncertain": {
    en: "Connection dropped after the request was sent. Refresh before trying again.",
    ar: "انقطع الاتصال بعد إرسال الطلب. حدّث قبل المحاولة مجددًا.",
  },
  "changes.clean": { en: "No changed files.", ar: "لا توجد ملفات متغيرة." },
  "changes.binary": { en: "Binary file.", ar: "ملف ثنائي." },
  "changes.tooLarge": { en: "Diff is too large to display.", ar: "الفرق كبير جدًا للعرض." },
  "changes.stage": { en: "Stage", ar: "إضافة" },
  "changes.unstage": { en: "Unstage", ar: "إزالة" },
  "changes.commitPlaceholder": { en: "Commit message", ar: "رسالة الحفظ" },
  "changes.commit": { en: "Commit", ar: "حفظ" },
  // Fix round 1 (Important 1 + Minor): a mutation the store refused because
  // the connection isn't open — distinct from a server-side error, so the
  // draft is kept and the user is told to reconnect, not just left silent.
  "changes.offline": {
    en: "Not connected — your message is kept. Reconnect and try again.",
    ar: "غير متصل — تم الاحتفاظ برسالتك. أعد الاتصال وحاول مرة أخرى.",
  },
  // Fix round 2 (New Breakage 2): a mutation dropped because the session
  // changed while it was queued — distinct from being offline, since the
  // connection was fine the whole time.
  "changes.sessionChanged": {
    en: "Switched sessions before this went through — nothing was sent. Your message is kept.",
    ar: "تم تبديل الجلسة قبل إتمام هذا الإجراء — لم يُرسل شيء. تم الاحتفاظ برسالتك.",
  },
  // Fix round 1 (Minor): the raw RPC error kind "unsupported" was shown as
  // a literal English word in both languages.
  "changes.unsupported": {
    en: "The connected computer doesn't support this action yet.",
    ar: "الكمبيوتر المتصل لا يدعم هذا الإجراء بعد.",
  },
  // Fix round 1 (Important 3): a reply that didn't match the expected
  // shape — no real server text exists for this, so `""` would render as
  // nothing at all.
  "changes.malformedReply": {
    en: "The server's reply couldn't be read.",
    ar: "تعذّرت قراءة رد الخادم.",
  },
  "history.title": { en: "History", ar: "السجل" },
  "history.transcript": { en: "Transcript", ar: "النص" },
  "history.loading": { en: "Loading sessions…", ar: "جارٍ تحميل الجلسات…" },
  "history.empty": { en: "No saved sessions.", ar: "لا توجد جلسات محفوظة." },
  "history.emptyTranscript": { en: "No transcript entries.", ar: "لا توجد مدخلات نصية." },
  "history.notFound": { en: "Session not found.", ar: "الجلسة غير موجودة." },
  "history.user": { en: "User", ar: "المستخدم" },
  "history.assistant": { en: "Assistant", ar: "المساعد" },
  "voice.title": { en: "Voice", ar: "الصوت" },
  "voice.targetBrain": { en: "Talking to Jarvis", ar: "التحدث إلى جارفيس" },
  "voice.start": { en: "Tap to speak", ar: "اضغط للتحدث" },
  "voice.stop": { en: "Stop recording", ar: "إيقاف التسجيل" },
  "voice.startForSession": {
    en: "Speak to this agent (sends with Enter)",
    ar: "تحدث إلى هذا العميل (يُرسل بالضغط على Enter)",
  },
  "voice.recording": { en: "Recording…", ar: "جارٍ التسجيل…" },
  "voice.sending": { en: "Sending…", ar: "جارٍ الإرسال…" },
  "voice.waitingReply": { en: "Waiting for a reply…", ar: "بانتظار الرد…" },
  "voice.speaking": { en: "Speaking…", ar: "جارٍ التحدث…" },
  "voice.stopSpeaking": { en: "Stop speaking", ar: "إيقاف الكلام" },
  "voice.retry": { en: "Retry", ar: "إعادة المحاولة" },
  "voice.discard": { en: "Discard", ar: "تجاهل" },
  "voice.openSettings": { en: "Open Settings", ar: "فتح الإعدادات" },
  "voice.empty": { en: "No conversation yet.", ar: "لا توجد محادثة بعد." },
  "voice.you": { en: "You", ar: "أنت" },
  "voice.jarvis": { en: "Jarvis", ar: "جارفيس" },
  "voice.spoken": { en: "Spoken", ar: "تم النطق" },
  "voice.thinking": { en: "Thinking", ar: "جارٍ التفكير" },
  "voice.notice.micDenied": {
    en: "Microphone access was denied. You can try again.",
    ar: "تم رفض الوصول إلى الميكروفون. يمكنك المحاولة مرة أخرى.",
  },
  "voice.notice.micBlocked": {
    en: "Microphone access is blocked. Enable it in Settings.",
    ar: "الوصول إلى الميكروفون محظور. فعّله من الإعدادات.",
  },
  "voice.notice.recorderFailed": {
    en: "Couldn't start recording. Try again.",
    ar: "تعذّر بدء التسجيل. حاول مرة أخرى.",
  },
  "voice.notice.tooShort": { en: "Recording was too short.", ar: "التسجيل كان قصيرًا جدًا." },
  "voice.notice.tooLarge": { en: "Recording was too large.", ar: "التسجيل كان كبيرًا جدًا." },
  "voice.notice.notSentOffline": {
    en: "Not sent: phone is disconnected.",
    ar: "لم يُرسل: الهاتف غير متصل.",
  },
  "voice.notice.notSentBusy": {
    en: "Not sent: still busy with another upload. Try again.",
    ar: "لم يُرسل: لا يزال مشغولًا برفع آخر. حاول مرة أخرى.",
  },
  "voice.notice.uncertain": {
    en: "Connection lost; the recording may have been sent. Check before retrying.",
    ar: "فُقد الاتصال؛ ربما أُرسل التسجيل. تحقق قبل إعادة المحاولة.",
  },
  "voice.notice.stoppedInBackground": {
    en: "Recording stopped because the app went to the background.",
    ar: "توقّف التسجيل لأن التطبيق انتقل إلى الخلفية.",
  },
  "voice.notice.noReply": {
    en: "No reply arrived — check the laptop.",
    ar: "لم يصل أي رد — تحقق من الكمبيوتر.",
  },
  "voice.notice.noVoiceAr": {
    en: "This phone has no Arabic voice installed.",
    ar: "لا يوجد صوت عربي مثبّت على هذا الهاتف.",
  },
  "voice.notice.noVoiceEn": {
    en: "This phone has no English voice installed.",
    ar: "لا يوجد صوت إنجليزي مثبّت على هذا الهاتف.",
  },
  "voice.notice.laptopTooOld": {
    en: "Update Jarvis on your computer to use voice.",
    ar: "حدّث Jarvis على جهاز الكمبيوتر لاستخدام الصوت.",
  },
  "voice.notice.failed": {
    en: "Something went wrong. Try again.",
    ar: "حدث خطأ ما. حاول مرة أخرى.",
  },
  "voice.notice.sentToSession": { en: "Sent to the session:", ar: "أُرسل إلى الجلسة:" },
  "settings.speakReplies": { en: "Speak replies", ar: "نطق الردود" },
  "settings.speakRepliesHint": {
    en: "Read Jarvis's replies aloud on this phone.",
    ar: "قراءة ردود جارفيس بصوت عالٍ على هذا الهاتف.",
  },
  "sidecars.title": {
    en: "Sidecars",
    ar: "الخدمات المساندة",
  },
  "sidecars.editor": {
    en: "Editor",
    ar: "المحرر",
  },
  "sidecars.database": {
    en: "Database",
    ar: "قاعدة البيانات",
  },
  "sidecars.cluster": {
    en: "Cluster",
    ar: "العنقود",
  },
  "sidecars.lanOnly": {
    en: "Connect over Tailscale with a real certificate to use the Editor, Database and Cluster on the phone.",
    ar: "اتصل عبر Tailscale بشهادة حقيقية لاستخدام المحرر وقاعدة البيانات والعنقود على الهاتف.",
  },
  "sidecars.opening": {
    en: "Opening…",
    ar: "جارٍ الفتح…",
  },
  "sidecars.openAgain": {
    en: "Open again",
    ar: "افتح مرة أخرى",
  },
  "sidecars.loadFailed": {
    en: "Couldn't load. Try again.",
    ar: "تعذّر التحميل. حاول مرة أخرى.",
  },
  "sidecars.unexpectedAddress": {
    en: "The computer answered with an unexpected address.",
    ar: "أجاب الكمبيوتر بعنوان غير متوقع.",
  },
  "sidecars.noRoots": {
    en: "Default (no folders configured)",
    ar: "الافتراضي (لا توجد مجلدات معدة)",
  },
  "sidecars.noClusters": {
    en: "No clusters connected.",
    ar: "لا توجد عناقيد متصلة.",
  },
  "sidecars.desktopSite": {
    en: "Desktop site",
    ar: "نسخة سطح المكتب",
  },
  "sidecars.zoomIn": {
    en: "Zoom in",
    ar: "تكبير",
  },
  "sidecars.zoomOut": {
    en: "Zoom out",
    ar: "تصغير",
  },
  "docker.title": {
    en: "Docker",
    ar: "دوكر",
  },
  "docker.loadFailed": {
    en: "Couldn't load containers. Try again.",
    ar: "تعذّر تحميل الحاويات. حاول مرة أخرى.",
  },
  "docker.noContainers": {
    en: "No containers configured for this project.",
    ar: "لا توجد حاويات مهيأة لهذا المشروع.",
  },
  "docker.notFound": {
    en: "Not found on this machine",
    ar: "غير موجودة على هذا الجهاز",
  },
  "docker.start": {
    en: "Start",
    ar: "تشغيل",
  },
  "docker.stop": {
    en: "Stop",
    ar: "إيقاف",
  },
  "docker.restart": {
    en: "Restart",
    ar: "إعادة تشغيل",
  },
  "docker.follow": {
    en: "Follow log",
    ar: "متابعة السجل",
  },
  "docker.composeUp": {
    en: "Compose up",
    ar: "تشغيل الحزمة",
  },
  "docker.composeDown": {
    en: "Compose down",
    ar: "إيقاف الحزمة",
  },
  "docker.confirmStop": {
    en: "Stop {name}?",
    ar: "إيقاف {name}؟",
  },
  "docker.confirmRestart": {
    en: "Restart {name}?",
    ar: "إعادة تشغيل {name}؟",
  },
  "docker.confirmComposeDown": {
    en: "Take down the {project} stack? This removes its containers.",
    ar: "هل تريد إيقاف حزمة {project} وإزالة حاوياتها؟",
  },
  "docker.shellLaptopOnly": {
    en: "A container shell is only available on the laptop.",
    ar: "صدفة الحاوية متاحة فقط على الكمبيوتر.",
  },
  "docker.uncertain": {
    en: "Connection lost after the request was sent. Refresh before trying again.",
    ar: "انقطع الاتصال بعد إرسال الطلب. حدّث قبل المحاولة مجددًا.",
  },
  "docker.busy": {
    en: "Still working on the previous action — wait for it to finish.",
    ar: "ما زال الإجراء السابق قيد التنفيذ — انتظر حتى ينتهي.",
  },
  "docker.log.liveOnly": {
    en: "Live only — this log isn't saved. Leaving or losing the connection loses what's shown.",
    ar: "مباشر فقط — لا يُحفظ هذا السجل. مغادرة الشاشة أو فقدان الاتصال يفقد ما هو معروض.",
  },
  "docker.log.stop": {
    en: "Stop following",
    ar: "إيقاف المتابعة",
  },
  "docker.log.waiting": {
    en: "Reconnecting…",
    ar: "جارٍ إعادة الاتصال…",
  },
  "docker.log.followFailed": {
    en: "Couldn't follow this container's log. Try again.",
    ar: "تعذّرت متابعة سجل هذه الحاوية. حاول مرة أخرى.",
  },
  "docker.log.trimmed": {
    en: "Older output trimmed: {amount}",
    ar: "تم اقتطاع مخرجات أقدم: {amount}",
  },
  "docker.malformedReply": {
    en: "The server's reply couldn't be read.",
    ar: "تعذّرت قراءة رد الخادم.",
  },
  // M9 Task 7: the Workspace screen (laptop tabs by project, plus the
  // Docker/Sidecars/Terminal/Chat entry points a project always offers)
  // and the existing-terminal-pane screen it opens.
  "workspace.title": { en: "Workspace", ar: "مساحة العمل" },
  "workspace.loading": { en: "Loading workspace…", ar: "جارٍ تحميل مساحة العمل…" },
  "workspace.loadFailed": {
    en: "Couldn't load. Try again.",
    ar: "تعذّر التحميل. حاول مرة أخرى.",
  },
  "workspace.subscribeUnsupported": {
    en: "This computer's Jarvis is out of date — live updates are off. Pull to refresh instead.",
    ar: "إصدار جارفيس على هذا الجهاز قديم — التحديثات المباشرة متوقفة. اسحب للتحديث بدلاً من ذلك.",
  },
  "workspace.noTabs": { en: "No open tabs.", ar: "لا توجد تبويبات مفتوحة." },
  "workspace.openOnLaptop": { en: "Open on the laptop", ar: "مفتوح على الحاسوب" },
  "workspace.newTerminal": { en: "New terminal", ar: "طرفية جديدة" },
  "workspace.openingTerminal": { en: "Opening…", ar: "جارٍ الفتح…" },
  "workspace.terminal": { en: "Terminal", ar: "الطرفية" },
  "workspace.chat": { en: "Chat", ar: "الدردشة" },
  "workspace.chatUnavailable": {
    en: "No chat configured for this project.",
    ar: "لا توجد دردشة معدة لهذا المشروع.",
  },
  "workspace.openFailed": {
    en: "Couldn't open that. Try again.",
    ar: "تعذّر الفتح. حاول مرة أخرى.",
  },
  "workspace.unsafeUrl": {
    en: "That address isn't safe to open.",
    ar: "هذا العنوان غير آمن للفتح.",
  },
  "workspace.panes.title": { en: "Terminal panes", ar: "أجزاء الطرفية" },
  "workspace.panes.empty": { en: "No panes.", ar: "لا توجد أجزاء." },
  "workspace.panes.exited": { en: "Exited", ar: "منتهية" },
  "workspace.panes.live": { en: "Live", ar: "مباشرة" },
  "terminal.notFound": {
    en: "This terminal pane is no longer available.",
    ar: "لم تعد هذه اللوحة الطرفية متاحة.",
  },
  "terminal.exited": {
    en: "This terminal has exited. You can still read its output.",
    ar: "خرجت هذه الطرفية. يمكنك الاستمرار في قراءة مخرجاتها.",
  },
  // M9 Task 5: the API pane (collections, drill-down, the request editor,
  // send/save, history/cookies/settings and Postman import).
  "api.title": { en: "API", ar: "واجهة برمجية" },
  "api.loading": { en: "Loading collections…", ar: "جارٍ تحميل المجموعات…" },
  "api.loadFailed": { en: "Couldn't load. Try again.", ar: "تعذّر التحميل. حاول مرة أخرى." },
  "api.busy": { en: "Still working on the last action.", ar: "لا تزال معالجة الإجراء السابق." },
  "api.capabilityMissing": {
    en: "Not available on this laptop app yet.",
    ar: "غير متاح بعد في تطبيق الكمبيوتر هذا.",
  },
  "api.noCollections": {
    en: "No API collections in this project.",
    ar: "لا توجد مجموعات API في هذا المشروع.",
  },
  "api.collections.title": { en: "Collections", ar: "المجموعات" },
  "api.newCollection": { en: "New collection", ar: "مجموعة جديدة" },
  "api.newCollection.placeholder": { en: "Collection name", ar: "اسم المجموعة" },
  "api.tree.loading": { en: "Loading…", ar: "جارٍ التحميل…" },
  "api.tree.none": { en: "Pick a collection above.", ar: "اختر مجموعة أعلاه." },
  "api.tree.addRequest": { en: "+ Request", ar: "+ طلب" },
  "api.tree.addFolder": { en: "+ Folder", ar: "+ مجلد" },
  "api.kv.name": { en: "Name", ar: "الاسم" },
  "api.kv.value": { en: "Value", ar: "القيمة" },
  "api.kv.remove": { en: "Remove", ar: "إزالة" },
  "api.kv.add": { en: "+ Add", ar: "+ إضافة" },
  "api.secret.reveal": { en: "Reveal", ar: "إظهار" },
  "api.secret.hide": { en: "Hide", ar: "إخفاء" },
  "api.request.noneSelected": { en: "Pick a request to edit it.", ar: "اختر طلبًا لتحريره." },
  "api.request.method": { en: "Method", ar: "الطريقة" },
  "api.request.url": { en: "URL", ar: "الرابط" },
  "api.request.headers": { en: "Headers", ar: "الترويسات" },
  "api.request.query": { en: "Query params", ar: "معاملات الاستعلام" },
  "api.request.pathParams": { en: "Path params", ar: "معاملات المسار" },
  "api.request.body": { en: "Body", ar: "المحتوى" },
  "api.request.auth": { en: "Auth", ar: "المصادقة" },
  "api.request.variables": { en: "Variables", ar: "المتغيرات" },
  "api.request.environments": { en: "Environments", ar: "البيئات" },
  "api.request.send": { en: "Send", ar: "إرسال" },
  "api.request.save": { en: "Save", ar: "حفظ" },
  "api.request.dirty": { en: "Unsaved changes", ar: "تغييرات غير محفوظة" },
  "api.body.none": { en: "None", ar: "بلا" },
  "api.body.text": { en: "Text", ar: "نص" },
  "api.body.formUrlEncoded": { en: "Form", ar: "نموذج" },
  "api.body.multipartForm": { en: "Multipart", ar: "متعدد الأجزاء" },
  "api.auth.none": { en: "None", ar: "بلا" },
  "api.auth.inherit": { en: "Inherit", ar: "موروثة" },
  "api.auth.bearer": { en: "Bearer", ar: "رمز Bearer" },
  "api.auth.basic": { en: "Basic", ar: "أساسية" },
  "api.auth.apikey": { en: "API key", ar: "مفتاح API" },
  "api.auth.token": { en: "Token", ar: "الرمز" },
  "api.auth.username": { en: "Username", ar: "اسم المستخدم" },
  "api.auth.password": { en: "Password", ar: "كلمة المرور" },
  "api.auth.apikeyKey": { en: "Key", ar: "المفتاح" },
  "api.auth.apikeyValue": { en: "Value", ar: "القيمة" },
  "api.multipart.attach": { en: "Attach file", ar: "إرفاق ملف" },
  "api.multipart.attaching": { en: "Uploading…", ar: "جارٍ الرفع…" },
  "api.multipart.attached": { en: "Attached: {name}", ar: "أُرفق: {name}" },
  "api.multipart.attachFailed": { en: "Couldn't attach that file.", ar: "تعذّر إرفاق هذا الملف." },
  "api.multipart.fieldName": { en: "Field name", ar: "اسم الحقل" },
  "api.multipart.fieldContentType": { en: "Content type (optional)", ar: "نوع المحتوى (اختياري)" },
  "api.environment.title": { en: "Environment", ar: "البيئة" },
  "api.environment.none": { en: "Ad-hoc", ar: "بدون بيئة" },
  "api.environment.save": { en: "Save environment", ar: "حفظ البيئة" },
  "api.environment.namePlaceholder": { en: "Environment name", ar: "اسم البيئة" },
  "api.collection.delete": { en: "Delete collection", ar: "حذف المجموعة" },
  "api.upload.cancel": { en: "Cancel", ar: "إلغاء" },
  "api.upload.cancelled": { en: "Upload cancelled.", ar: "أُلغي الرفع." },
  "api.upload.overLimit": {
    en: "That file is larger than the 25 MiB limit.",
    ar: "هذا الملف أكبر من الحد الأقصى 25 ميبي بايت.",
  },
  "api.upload.busy": {
    en: "Already uploading something else — wait for it to finish.",
    ar: "جارٍ رفع شيء آخر بالفعل — انتظر حتى ينتهي.",
  },
  "api.upload.offline": { en: "Not connected — try again.", ar: "غير متصل — حاول مرة أخرى." },
  "api.upload.failed": { en: "Couldn't upload that file.", ar: "تعذّر رفع هذا الملف." },
  "api.warning.hooksSend": {
    en: "Pre-request/post-response scripts and tests are skipped when sent from a phone.",
    ar: "يتم تخطي نصوص واختبارات ما قبل الطلب وما بعد الاستجابة عند الإرسال من الهاتف.",
  },
  "api.warning.hooksSave": {
    en: "Saving from a phone removes any scripts and tests this request had.",
    ar: "الحفظ من الهاتف يزيل أي نصوص واختبارات كانت لهذا الطلب.",
  },
  "api.warning.attachmentsTemporary": {
    en: "Attached files are temporary and expire after an hour.",
    ar: "الملفات المرفقة مؤقتة وتنتهي صلاحيتها بعد ساعة.",
  },
  "api.warning.oauthSettingsLaptopOnly": {
    en: "OAuth2 requests and network settings changes require the laptop app.",
    ar: "طلبات OAuth2 وتغييرات إعدادات الشبكة تتطلب تطبيق الكمبيوتر.",
  },
  "api.response.title": { en: "Response", ar: "الاستجابة" },
  "api.response.none": { en: "No response yet.", ar: "لا توجد استجابة بعد." },
  "api.uncertain": {
    en: "Connection dropped — check history to see if this actually ran.",
    ar: "انقطع الاتصال — تحقق من السجل لمعرفة ما إذا كان هذا قد تم فعليًا.",
  },
  "api.tabs.editor": { en: "Request", ar: "الطلب" },
  "api.tabs.history": { en: "History", ar: "السجل" },
  "api.tabs.cookies": { en: "Cookies", ar: "الكعكات" },
  "api.tabs.settings": { en: "Settings", ar: "الإعدادات" },
  "api.history.clear": { en: "Clear history", ar: "مسح السجل" },
  "api.history.empty": { en: "No requests yet.", ar: "لا توجد طلبات بعد." },
  "api.cookies.clear": { en: "Clear cookies", ar: "مسح الكعكات" },
  "api.cookies.empty": { en: "No cookies stored.", ar: "لا توجد كعكات مخزنة." },
  "api.settings.proxy": { en: "Proxy: {value}", ar: "الوكيل: {value}" },
  "api.settings.verifyCertificate": {
    en: "Verify certificate: {value}",
    ar: "التحقق من الشهادة: {value}",
  },
  "api.settings.timeout": { en: "Timeout: {ms} ms", ar: "المهلة: {ms} ms" },
  "api.settings.load": { en: "Load settings", ar: "تحميل الإعدادات" },
  "api.settings.laptopOnly": {
    en: "Changing these requires the laptop app.",
    ar: "تغيير هذه الإعدادات يتطلب تطبيق الكمبيوتر.",
  },
  "api.import.title": { en: "Import Postman collection", ar: "استيراد مجموعة Postman" },
  "api.import.pick": { en: "Pick a file…", ar: "اختر ملفًا…" },
  "api.import.uploading": { en: "Uploading…", ar: "جارٍ الرفع…" },
  "api.import.name": { en: "Name", ar: "الاسم" },
  "api.import.requestCount": { en: "{count} requests", ar: "{count} طلبات" },
  "api.import.confirm": { en: "Import", ar: "استيراد" },
  "api.import.failed": {
    en: "Couldn't read that file as a Postman collection.",
    ar: "تعذّرت قراءة هذا الملف كمجموعة Postman.",
  },
  "api.confirmDelete": {
    en: "Delete “{name}”? This can't be undone.",
    ar: "حذف “{name}”؟ لا يمكن التراجع عن هذا.",
  },
  "api.rename.title": { en: "Rename", ar: "إعادة تسمية" },
} as const satisfies Record<string, Record<Language, string>>;

export type MessageKey = keyof typeof STRINGS;

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

export function t(
  language: Language,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = STRINGS[key][language];
  if (!params) {
    return template;
  }
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function languageFromLocale(localeTag: string): Language {
  const languageSubtag = localeTag.split(/[-_]/, 1)[0]?.toLowerCase();
  return languageSubtag === "ar" ? "ar" : "en";
}

export function isRtl(language: Language): boolean {
  return language === "ar";
}
