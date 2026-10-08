package pkgtools

import "github.com/mmAbdelhay/jarvis/os/go/internal/i18n"

// pkgCard is every string jarvis-pkg puts on a package or update card
// (M1 contracts §6.5, Rafiq M4 contracts §3). Error messages are not
// here: they go to the model, which explains them in the user's language.
type pkgCard struct {
	InstallOne, InstallMany     string // %s name | %d count, %s names
	RemoveOne, RemoveMany       string
	SourceDebian, SourceFlathub string `i18n:"keep"`
	InstallLine                 string // id, version, source, download size
	RemoveLine                  string // id, version, source, freed size
	LookupFailed                string // id, source, reason
	RemoveUnknown               string // id, source
	UpgradeOne                  string // id, from, to, "Debian" | "Debian, security" | "Flathub"
	UpgradeUnknown              string // id, where (versions could not be read)
	UpgradeMany                 string // count, ids
	UpgradeLine                 string // id, from, to, source, security note
	UpgradeLineUnknown          string // id, source, security note
	SecuritySuffix              string // appended to the source in the title
	SecurityNote                string // appended to the detail line
	UnitBytes                   string // %d count of bytes
	UnitKB, UnitMB, UnitGB      string
	UnitTB                      string
}

var cardText = i18n.NewTable("jarvis-pkg/card",
	pkgCard{
		InstallOne:    "Install %s",
		InstallMany:   "Install %d apps: %s",
		RemoveOne:     "Remove %s",
		RemoveMany:    "Remove %d apps: %s",
		SourceDebian:  "Debian",
		SourceFlathub: "Flathub",
		InstallLine:   "%s %s from %s, %s download",
		RemoveLine:    "%s %s from %s, frees about %s",
		LookupFailed:  "%s: could not be looked up in %s (%s)",
		RemoveUnknown: "%s from %s",

		UpgradeOne:         "Upgrade %s %s → %s (%s)",
		UpgradeUnknown:     "Upgrade %s (%s)",
		UpgradeMany:        "Upgrade %d apps: %s",
		UpgradeLine:        "%s %s → %s from %s%s. Nothing is removed.",
		UpgradeLineUnknown: "%s: newest version from %s%s. Nothing is removed.",
		SecuritySuffix:     ", security",
		SecurityNote:       " (security update)",

		UnitBytes: "%d bytes",
		UnitKB:    "kB",
		UnitMB:    "MB",
		UnitGB:    "GB",
		UnitTB:    "TB",
	},
	pkgCard{
		InstallOne:    "تثبيت %s",
		InstallMany:   "تثبيت %d من التطبيقات: %s",
		RemoveOne:     "إزالة %s",
		RemoveMany:    "إزالة %d من التطبيقات: %s",
		SourceDebian:  i18n.FSI + "Debian" + i18n.PDI,
		SourceFlathub: i18n.FSI + "Flathub" + i18n.PDI,
		InstallLine:   "%s %s من %s، حجم التنزيل %s",
		RemoveLine:    "%s %s من %s، يحرّر نحو %s",
		LookupFailed:  "%s: تعذّر العثور عليه في %s (%s)",
		RemoveUnknown: "%s من %s",

		UpgradeOne:         "ترقية %s من %s إلى %s (%s)",
		UpgradeUnknown:     "ترقية %s (%s)",
		UpgradeMany:        "ترقية %d من التطبيقات: %s",
		UpgradeLine:        "%s من %s إلى %s عبر %s%s. لن يُزال أي شيء.",
		UpgradeLineUnknown: "%s: أحدث إصدار عبر %s%s. لن يُزال أي شيء.",
		SecuritySuffix:     "، تحديث أمني",
		SecurityNote:       " (تحديث أمني)",

		UnitBytes: "%d بايت",
		UnitKB:    "كيلوبايت",
		UnitMB:    "ميغابايت",
		UnitGB:    "غيغابايت",
		UnitTB:    "تيرابايت",
	},
)

// registryCard is every string jarvis-pkg puts on a registry card
// (Rafiq M2.5 contracts §3, M4 §3).
type registryCard struct {
	InstallTitle  string // name, version
	RemoveTitle   string // id
	RemoveDetail  string // version
	TierOfficial  string
	TierReviewed  string
	TierCommunity string
	ToolsLine     string // comma-separated tool names
	NetworkYes    string
	NetworkNo     string
	FilesReadOnly string
	FilesWritable string // comma-separated "~/" paths
	Separator     string `i18n:"keep"`
}

var registryText = i18n.NewTable("jarvis-pkg/registry",
	registryCard{
		InstallTitle:  "Add tool server %s %s",
		RemoveTitle:   "Remove tool server %s",
		RemoveDetail:  "Version %s and its files are deleted; its tools stop working.",
		TierOfficial:  "Official: made by the Rafiq project",
		TierReviewed:  "Reviewed: checked by the Rafiq project",
		TierCommunity: "Community: not reviewed by the Rafiq project; every action it takes will ask you first",
		ToolsLine:     "Tools: %s",
		NetworkYes:    "Can use the internet",
		NetworkNo:     "No internet access",
		FilesReadOnly: "Can read your home folder, cannot change it",
		FilesWritable: "Can read your home folder; can change: %s",
		Separator:     " · ",
	},
	registryCard{
		InstallTitle:  "إضافة خادم الأدوات %s %s",
		RemoveTitle:   "إزالة خادم الأدوات %s",
		RemoveDetail:  "سيُحذف الإصدار %s وملفاته، وتتوقف أدواته عن العمل.",
		TierOfficial:  "رسمي: من إعداد مشروع رفيق",
		TierReviewed:  "مُراجَع: فحصه مشروع رفيق",
		TierCommunity: "مجتمعي: لم يراجعه مشروع رفيق، وسيستأذنك قبل كل إجراء يقوم به",
		ToolsLine:     "الأدوات: %s",
		NetworkYes:    "يمكنه استخدام الإنترنت",
		NetworkNo:     "لا يصل إلى الإنترنت",
		FilesReadOnly: "يمكنه قراءة مجلدك الشخصي دون تغييره",
		FilesWritable: "يمكنه قراءة مجلدك الشخصي، ويمكنه تغيير: %s",
		Separator:     " · ",
	},
)
