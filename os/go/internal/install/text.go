package install

import (
	"strings"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
)

// installText is every user-facing string the backend produces: Review
// summary lines, warnings, step titles, refusal reasons and progress
// details, in English and Arabic (M4 contracts §6.6: the backend speaks the
// language of Choices.locale). Fields tagged keep are D-Bus argument errors
// the installer UI prevents before it calls; like every error meant for a
// program, they stay English.
type installText struct {
	ChoicesDecode        string `i18n:"keep"`
	DiskDecode           string `i18n:"keep"`
	UserDecode           string `i18n:"keep"`
	SecretsDecode        string `i18n:"keep"`
	InvalidLocale        string `i18n:"keep"`
	InvalidKeyboard      string `i18n:"keep"`
	InvalidTimezone      string `i18n:"keep"`
	InvalidUsername      string `i18n:"keep"`
	InvalidHostname      string `i18n:"keep"`
	InvalidFullName      string `i18n:"keep"`
	MissingModelID       string `i18n:"keep"`
	InvalidModel         string `i18n:"keep"`
	InvalidBrainKind     string `i18n:"keep"`
	InvalidBaseURL       string `i18n:"keep"`
	InvalidPassword      string `i18n:"keep"`
	MissingPassphrase    string `i18n:"keep"`
	UnexpectedPassphrase string `i18n:"keep"`
	InvalidPassphrase    string `i18n:"keep"`

	// Summary lines.
	EraseDisk, EraseCreate                      string
	AlongsideShrink, ESPReuse, ESPCreate        string
	ManualRoot, ManualESPKeep, ManualESPFormat  string
	ManualSwapKeep, ManualSwapFormat            string
	BootCreate, ManualBootFormat                string
	EncryptOn, EncryptOff                       string
	Regional, Account, LoginAuto, LoginPassword string
	BrainLocal, BrainLocalLater, BrainCloud     string
	BrainLAN, FreeAfter                         string
	Encrypted                                   string
	// Warnings.
	NoUndo, EraseAll, AlongsideBackup, Chkdsk string
	Removable                                 string
	// Step titles.
	StepPartition, StepShrink, StepEncrypt string
	StepFormat, StepCopy, StepConfigure    string
	StepBootloader, StepModel              string
	// Disk-after labels.
	LabelESP, LabelJarvis, LabelWindows, LabelSwap string
	LabelBoot                                      string
	LabelPartition                                 string
	// Refusal reasons.
	NoUEFI, DiskTooSmall, Bitlocker, Hibernated, Dirty string
	LiveMedium                                         string
	AlongsideTooSmall, NoWindows                       string
	ManualNoRoot, ManualNoESP, ManualSmallESP          string
	ManualNoBoot, ManualSmallBoot                      string
	ModelTooBigDisk, ModelTooBigRAM, ModelNeedsGPU     string
	// Progress details.
	Preflight, Cancelled, DiskChanged, ModelOffline string
	ModelWaiting, ModelDownloading, ModelDone       string
	ModelLater, Done                                string
	NoteSecureBootOff, NoteNoNVRAM                  string
}

var textEN = installText{ChoicesDecode: "choices: %v",
	DiskDecode:           "choices.disk: %v",
	UserDecode:           "choices.user: %v",
	SecretsDecode:        "secrets: malformed",
	InvalidLocale:        "locale %q is not like en_US.UTF-8",
	InvalidKeyboard:      "keyboard %q is not an XKB layout like us or us(intl)",
	InvalidTimezone:      "time zone %q is not like Africa/Cairo",
	InvalidUsername:      "username %q is not allowed: use lower-case letters, digits, - and _",
	InvalidHostname:      "computer name %q is not allowed: use lower-case letters, digits and -",
	InvalidFullName:      "full name must be 1-100 characters without : , = or \\",
	MissingModelID:       "brain.modelId is required",
	InvalidModel:         "brain.model must be 1-200 characters",
	InvalidBrainKind:     "brain.kind must be local, cloud or lan",
	InvalidBaseURL:       "brain.baseUrl must be an http(s) URL without credentials, query or fragment",
	InvalidPassword:      "the password must be 1-1024 characters without control characters",
	MissingPassphrase:    "an encryption passphrase is required",
	UnexpectedPassphrase: "an encryption passphrase was given but encryption is off",
	InvalidPassphrase:    "the encryption passphrase must be 8-512 characters without control characters",
	EraseDisk:            "Erase the whole disk %s (%s, %s). Everything on it is deleted.",
	EraseCreate:          "Create a %s boot partition (EFI) and a %s %sRafiq partition.",
	AlongsideShrink:      "Shrink Windows from %s to %s, create %s %sRafiq.",
	ESPReuse:             "Use the existing boot partition %s, shared with Windows.",
	ESPCreate:            "Create a new %s boot partition (EFI).",
	ManualRoot:           "Format %s (%s) for %sRafiq. Everything on it is deleted.",
	ManualESPKeep:        "Use %s as the boot partition (EFI), without formatting it.",
	ManualESPFormat:      "Format %s as the boot partition (EFI). Everything on it is deleted.",
	ManualSwapKeep:       "Use %s as swap.",
	ManualSwapFormat:     "Format %s as swap. Everything on it is deleted.",
	BootCreate:           "Create a %s start-up partition (/boot) for Rafiq. It is not encrypted: it holds only the programs that ask for your passphrase.",
	ManualBootFormat:     "Format %s (%s) as Rafiq's start-up partition (/boot). It is not encrypted. Everything on it is deleted.",
	EncryptOn:            "Encryption is on: you type a passphrase each time the computer starts.",
	EncryptOff:           "Encryption is off: anyone with the disk can read your files.",
	Regional:             "Language %s, keyboard %s, time zone %s.",
	Account:              "Your account: %s (%s) on the computer %q.",
	LoginAuto:            "Logs in automatically.",
	LoginPassword:        "Asks for your password at the login screen.",
	BrainLocal:           "Jarvis thinks on this computer with %s (%s download).",
	BrainLocalLater:      "Jarvis thinks on this computer with %s (%s download, finished after the first restart because there is no internet now).",
	BrainCloud:           "Jarvis thinks with a cloud service; you add its key after you first log in.",
	BrainLAN:             "Jarvis thinks with %s on the server %s.",
	FreeAfter:            "About %s stays free for your files.",
	Encrypted:            "encrypted ",

	NoUndo:          "Nothing changes until you press Install. After that, the disk changes cannot be undone.",
	EraseAll:        "Everything on %s is deleted, including any other operating system.",
	AlongsideBackup: "Back up your files first. Shrinking Windows is safe, but a power cut while it runs could damage Windows.",
	Chkdsk:          "Windows checks its disk once the next time it starts. Let it finish.",
	Removable:       "%s is a removable drive. Rafiq will only start when it is plugged in.",

	StepPartition:  "Prepare the disk",
	StepShrink:     "Shrink Windows and prepare the disk",
	StepEncrypt:    "Encrypt",
	StepFormat:     "Create file systems",
	StepCopy:       "Copy Rafiq",
	StepConfigure:  "Set up your account and settings",
	StepBootloader: "Install the boot loader",
	StepModel:      "Download Jarvis's brain",

	LabelESP:       "EFI boot",
	LabelJarvis:    "Rafiq",
	LabelWindows:   "Windows",
	LabelSwap:      "Swap",
	LabelBoot:      "Rafiq boot",
	LabelPartition: "Partition %d",

	LiveMedium:        "This is the USB drive Rafiq is running from. Choose another disk.",
	NoUEFI:            "This computer started in legacy BIOS mode. Rafiq needs UEFI: turn on UEFI in the firmware settings and start from the USB again.",
	DiskTooSmall:      "%s is too small: Rafiq needs at least %s.",
	Bitlocker:         "Windows on this disk is encrypted with BitLocker. Turn BitLocker off in Windows (or suspend it), then try again.",
	Hibernated:        "Windows did not shut down fully. Start Windows, hold Shift while you click Shut down, then try again.",
	Dirty:             "Windows needs to check its disk. Start Windows, let it finish, shut down while holding Shift, then try again.",
	AlongsideTooSmall: "There is not enough room: Rafiq needs at least %s, and Windows must keep at least %s.",
	NoWindows:         "There is no Windows installation on this disk to install alongside.",
	ManualNoRoot:      "Choose a partition for Rafiq (/).",
	ManualNoESP:       "Choose a boot partition (EFI) for /boot/efi.",
	ManualSmallESP:    "The boot partition %s must be an EFI system partition of at least %s.",
	ManualNoBoot:      "An encrypted Rafiq needs a separate, unencrypted start-up partition. Choose a partition for /boot.",
	ManualSmallBoot:   "The start-up partition %s must be a Linux partition (not the EFI one) of at least %s.",
	ModelTooBigDisk:   "%s needs %s of space; Rafiq would only have %s.",
	ModelTooBigRAM:    "%s needs %d GB of memory; this computer has %s.",
	ModelNeedsGPU:     "%s needs a graphics card with %d GB of memory.",

	Preflight:         "Checking the disk",
	Cancelled:         "Installation cancelled before any change was made.",
	DiskChanged:       "The disk changed since the plan was made. Nothing was changed; go back and review again.",
	ModelOffline:      "No internet: the model downloads after the first restart.",
	ModelWaiting:      "Starting the download",
	ModelDownloading:  "Downloading %s",
	ModelDone:         "%s is ready",
	ModelLater:        "The download will continue after the first restart.",
	Done:              "Rafiq is installed.",
	NoteSecureBootOff: "Secure Boot is off on this computer. Rafiq starts anyway; you can turn Secure Boot on later in the firmware settings.",
	NoteNoNVRAM:       "The firmware did not accept a boot entry, so the computer starts Rafiq through its standard fallback loader. If it does not start, choose the disk in the firmware boot menu.",
}

var textAR = installText{
	ChoicesDecode:        "choices: %v",
	DiskDecode:           "choices.disk: %v",
	UserDecode:           "choices.user: %v",
	SecretsDecode:        "secrets: malformed",
	InvalidLocale:        "locale %q is not like en_US.UTF-8",
	InvalidKeyboard:      "keyboard %q is not an XKB layout like us or us(intl)",
	InvalidTimezone:      "time zone %q is not like Africa/Cairo",
	InvalidUsername:      "username %q is not allowed: use lower-case letters, digits, - and _",
	InvalidHostname:      "computer name %q is not allowed: use lower-case letters, digits and -",
	InvalidFullName:      "full name must be 1-100 characters without : , = or \\",
	MissingModelID:       "brain.modelId is required",
	InvalidModel:         "brain.model must be 1-200 characters",
	InvalidBrainKind:     "brain.kind must be local, cloud or lan",
	InvalidBaseURL:       "brain.baseUrl must be an http(s) URL without credentials, query or fragment",
	InvalidPassword:      "the password must be 1-1024 characters without control characters",
	MissingPassphrase:    "an encryption passphrase is required",
	UnexpectedPassphrase: "an encryption passphrase was given but encryption is off",
	InvalidPassphrase:    "the encryption passphrase must be 8-512 characters without control characters",
	EraseDisk:            "مسح القرص %s بالكامل (%s، %s). سيُحذف كل ما عليه.",
	EraseCreate:          "إنشاء قسم إقلاع " + efi + " بحجم %s، وقسم بحجم %s %sلرفيق.",
	AlongsideShrink:      "تصغير ويندوز من %s إلى %s، وإنشاء قسم بحجم %s %sلرفيق.",
	ESPReuse:             "استخدام قسم الإقلاع الموجود %s، المشترك مع ويندوز.",
	ESPCreate:            "إنشاء قسم إقلاع " + efi + " جديد بحجم %s.",
	ManualRoot:           "تهيئة %s (%s) %sلرفيق. سيُحذف كل ما عليه.",
	ManualESPKeep:        "استخدام %s قسمًا للإقلاع " + efi + " دون تهيئته.",
	ManualESPFormat:      "تهيئة %s قسمًا للإقلاع " + efi + ". سيُحذف كل ما عليه.",
	ManualSwapKeep:       "استخدام %s مساحةً للتبديل.",
	ManualSwapFormat:     "تهيئة %s مساحةً للتبديل. سيُحذف كل ما عليه.",
	BootCreate:           "إنشاء قسم بدء تشغيل بحجم %s (" + iso("/boot") + ") لرفيق. هذا القسم غير مشفّر: لا يحتوي إلا على البرامج التي تطلب عبارة المرور.",
	ManualBootFormat:     "تهيئة %s (%s) قسمًا لبدء تشغيل رفيق (" + iso("/boot") + "). هذا القسم غير مشفّر. سيُحذف كل ما عليه.",
	EncryptOn:            "التشفير مفعّل: ستكتب عبارة المرور في كل مرة يُشغَّل فيها الحاسوب.",
	EncryptOff:           "التشفير غير مفعّل: يستطيع أي شخص يحصل على القرص قراءة ملفاتك.",
	Regional:             "اللغة %s، ولوحة المفاتيح %s، والمنطقة الزمنية %s.",
	Account:              "حسابك: %s (%s) على الحاسوب %q.",
	LoginAuto:            "يُسجَّل الدخول تلقائيًا.",
	LoginPassword:        "تُطلب كلمة المرور في شاشة تسجيل الدخول.",
	BrainLocal:           "يفكّر جارفيس على هذا الحاسوب باستخدام %s (تنزيل بحجم %s).",
	BrainLocalLater:      "يفكّر جارفيس على هذا الحاسوب باستخدام %s (تنزيل بحجم %s يكتمل بعد إعادة التشغيل الأولى، لعدم توفر اتصال بالإنترنت الآن).",
	BrainCloud:           "يفكّر جارفيس عبر خدمة سحابية؛ وتضيف مفتاحها بعد أول تسجيل دخول.",
	BrainLAN:             "يفكّر جارفيس باستخدام %s على الخادم %s.",
	FreeAfter:            "تبقى نحو %s متاحة لملفاتك.",
	Encrypted:            "مشفّرًا ",

	NoUndo:          "لن يتغيّر شيء حتى تضغط «تثبيت». بعد ذلك لا يمكن التراجع عن تغييرات القرص.",
	EraseAll:        "سيُحذف كل ما على %s، بما في ذلك أي نظام تشغيل آخر.",
	AlongsideBackup: "انسخ ملفاتك احتياطيًا أولًا. تصغير ويندوز آمن، لكن انقطاع الكهرباء في أثنائه قد يُتلف ويندوز.",
	Chkdsk:          "سيفحص ويندوز قرصه مرة واحدة عند تشغيله التالي. اتركه حتى ينتهي.",
	Removable:       "%s قرص قابل للإزالة. لن يعمل رفيق إلا وهو موصول بالحاسوب.",

	StepPartition:  "تجهيز القرص",
	StepShrink:     "تصغير ويندوز وتجهيز القرص",
	StepEncrypt:    "التشفير",
	StepFormat:     "إنشاء أنظمة الملفات",
	StepCopy:       "نسخ رفيق",
	StepConfigure:  "إعداد حسابك وإعداداتك",
	StepBootloader: "تثبيت محمّل الإقلاع",
	StepModel:      "تنزيل عقل جارفيس",

	LabelESP:       "إقلاع " + iso("EFI"),
	LabelJarvis:    "رفيق",
	LabelWindows:   "ويندوز",
	LabelSwap:      "مساحة التبديل",
	LabelBoot:      "إقلاع رفيق",
	LabelPartition: "القسم %d",

	LiveMedium:        "هذا هو قرص " + iso("USB") + " الذي يعمل منه رفيق. اختر قرصًا آخر.",
	NoUEFI:            "بدأ هذا الحاسوب في وضع " + iso("BIOS") + " القديم. يحتاج رفيق إلى " + iso("UEFI") + ": فعّل " + iso("UEFI") + " في إعدادات البرنامج الثابت، ثم شغّل الحاسوب من قرص " + iso("USB") + " مجددًا.",
	DiskTooSmall:      "%s صغير جدًا: يحتاج رفيق إلى %s على الأقل.",
	Bitlocker:         "ويندوز على هذا القرص مشفّر باستخدام " + iso("BitLocker") + ". أوقف " + iso("BitLocker") + " في ويندوز (أو علّقه مؤقتًا)، ثم حاول مجددًا.",
	Hibernated:        "لم يُغلَق ويندوز إغلاقًا كاملًا. شغّل ويندوز، ثم اضغط مطولًا على مفتاح " + iso("Shift") + " وأنت تنقر «إيقاف التشغيل»، ثم حاول مجددًا.",
	Dirty:             "يحتاج ويندوز إلى فحص قرصه. شغّل ويندوز واتركه حتى ينتهي، ثم أوقف تشغيله مع الضغط مطولًا على مفتاح " + iso("Shift") + "، ثم حاول مجددًا.",
	AlongsideTooSmall: "لا توجد مساحة كافية: يحتاج رفيق إلى %s على الأقل، ويجب أن يبقى لويندوز %s على الأقل.",
	NoWindows:         "لا يوجد ويندوز مثبّت على هذا القرص لتثبيت رفيق بجانبه.",
	ManualNoRoot:      "اختر قسمًا لرفيق (/).",
	ManualNoESP:       "اختر قسم إقلاع " + efi + " للمسار " + iso("/boot/efi") + ".",
	ManualSmallESP:    "يجب أن يكون قسم الإقلاع %s قسم نظام " + iso("EFI") + " بحجم %s على الأقل.",
	ManualNoBoot:      "يحتاج رفيق المشفّر إلى قسم منفصل غير مشفّر لبدء التشغيل. اختر قسمًا للمسار " + iso("/boot") + ".",
	ManualSmallBoot:   "يجب أن يكون قسم بدء التشغيل %s قسم لينكس (وليس قسم " + iso("EFI") + ") بحجم %s على الأقل.",
	ModelTooBigDisk:   "يحتاج %s إلى مساحة %s، ولن يتوفر لرفيق سوى %s.",
	ModelTooBigRAM:    "يحتاج %s إلى %d غيغابايت من الذاكرة، وفي هذا الحاسوب %s.",
	ModelNeedsGPU:     "يحتاج %s إلى بطاقة رسوميات بذاكرة %d غيغابايت.",

	Preflight:         "فحص القرص",
	Cancelled:         "أُلغي التثبيت قبل إجراء أي تغيير.",
	DiskChanged:       "تغيّر القرص منذ إعداد الخطة. لم يتغيّر شيء؛ ارجع وراجع الخطة مجددًا.",
	ModelOffline:      "لا يوجد اتصال بالإنترنت: سيُنزَّل النموذج بعد إعادة التشغيل الأولى.",
	ModelWaiting:      "بدء التنزيل",
	ModelDownloading:  "جارٍ تنزيل %s",
	ModelDone:         "%s جاهز",
	ModelLater:        "سيستمر التنزيل بعد إعادة التشغيل الأولى.",
	Done:              "اكتمل تثبيت رفيق.",
	NoteSecureBootOff: "الإقلاع الآمن (" + iso("Secure Boot") + ") غير مفعّل على هذا الحاسوب. سيعمل رفيق رغم ذلك، ويمكنك تفعيل الإقلاع الآمن لاحقًا من إعدادات البرنامج الثابت.",
	NoteNoNVRAM:       "لم يقبل البرنامج الثابت إضافة مدخل إقلاع، لذا يشغّل الحاسوب رفيق عبر محمّل الإقلاع الاحتياطي القياسي. إذا لم يعمل، فاختر القرص من قائمة الإقلاع في البرنامج الثابت.",
}

// texts is the backend's table pair, checked by the i18n CI gate.
var texts = i18n.NewTable("jarvis-installer/text", textEN, textAR)

// text is the English table: argument errors (validate.go, types.go), which
// stay English, and tests.
var text = textEN

// efi is the "(EFI)" of the Arabic boot-partition lines, isolated.
var efi = "(" + iso("EFI") + ")"

func iso(s string) string { return i18n.FSI + s + i18n.PDI }

// langOf is the install's language: Arabic for an ar_* locale, else English.
func langOf(c Choices) i18n.Lang {
	lang, _, _ := strings.Cut(strings.NewReplacer(".", "_", "@", "_").Replace(c.Locale), "_")
	if lang == "ar" {
		return i18n.AR
	}
	return i18n.EN
}

// tr is one install's text and formatter.
type tr struct {
	l i18n.Lang
	t installText
}

func trFor(c Choices) tr {
	l := langOf(c)
	return tr{l: l, t: texts.Get(l)}
}

// f formats a line: fmt.Sprintf in English; in Arabic RLM first and every
// inserted string isolated (i18n.Sprintf).
func (x tr) f(format string, a ...any) string { return i18n.Sprintf(x.l, format, a...) }
