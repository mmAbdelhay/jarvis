package apptools

import "github.com/mmAbdelhay/jarvis/os/go/internal/i18n"

// appsCard is every string jarvis-apps puts on a confirm card (M1
// contracts §6.5, Rafiq M4 contracts §3).
type appsCard struct {
	CloseTitle, CloseAllTitle, CloseDetail string
	OpenURLTitle, OpenURLDetail            string
	KindWeb, KindEmail                     string // OpenURLDetail's %s
	DefaultTitle, None                     string
	DefaultDetail                          string `i18n:"keep"` // "<previous> → <current>" (Rafiq M4 contracts §6.4)
}

var cardText = i18n.NewTable("jarvis-apps/card",
	appsCard{
		CloseTitle:    "Close %s",
		CloseAllTitle: "Close all %d windows of %s",
		CloseDetail:   "%s · Unsaved work can be lost if the app does not ask first.",
		OpenURLTitle:  "Open %s",
		OpenURLDetail: "In your default %s app. The page is on the internet.",
		KindWeb:       "web",
		KindEmail:     "email",
		DefaultTitle:  "Make %s the default for %s",
		DefaultDetail: "%s → %s",
		None:          "none",
	},
	appsCard{
		CloseTitle:    "إغلاق %s",
		CloseAllTitle: "إغلاق كل نوافذ %[2]s (%[1]d)",
		CloseDetail:   "%s · قد يضيع العمل غير المحفوظ إن لم يسألك التطبيق أولًا.",
		OpenURLTitle:  "فتح %s",
		OpenURLDetail: "في تطبيق %s الافتراضي لديك. الصفحة على الإنترنت.",
		KindWeb:       "الويب",
		KindEmail:     "البريد",
		DefaultTitle:  "جعل %s التطبيق الافتراضي لـ%s",
		DefaultDetail: "%s ← %s",
		None:          "لا يوجد",
	},
)

// errText holds jarvis-apps' error messages; they go to the model and
// stay English (Rafiq M4 contracts §3).
var errText = struct {
	BadID, BadLimit, LaunchFailed, MimeFailed string
	NoApp, NotOpen, OneOf, BadURL, BadMime    string
	NoMime, NoWayland, TooManyPaths, BadQuery string
	NotFolderOrFile                           string
}{
	BadID:           "app id must be 1 to 255 printable characters without spaces",
	BadLimit:        "limit must be 1 to 200",
	LaunchFailed:    "could not start it: %v",
	MimeFailed:      "xdg-mime: %v",
	NoApp:           "no installed app has the id %q; use apps.list",
	NotOpen:         "%s has no open window; use apps.open",
	OneOf:           "give exactly one of windowId or appId",
	BadURL:          "%q is not an http, https or mailto address",
	BadMime:         "%q is not a MIME type like text/html or x-scheme-handler/https",
	NoMime:          "%s does not say it can open %s",
	NoWayland:       "windows can only be listed in the Rafiq desktop session: %v",
	TooManyPaths:    "at most 10 paths",
	BadQuery:        "query must be at most 100 characters",
	NotFolderOrFile: "%s is not a file or folder",
}
