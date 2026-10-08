package apptools

// text is every user-facing string of jarvis-apps (M1 contracts §6.5).
var text = struct {
	BadID, BadLimit, LaunchFailed, MimeFailed  string
	CloseTitle, CloseAllTitle, CloseDetail     string
	OpenFileTitle, OpenURLTitle, OpenURLDetail string
	DefaultTitle, DefaultDetail                string
	NoApp, NotOpen, OneOf, BadURL, BadMime     string
	NoMime, NoWayland, TooManyPaths, BadQuery  string
	NotFolderOrFile                            string
}{
	BadID:           "app id must be 1 to 255 printable characters without spaces",
	BadLimit:        "limit must be 1 to 200",
	LaunchFailed:    "could not start it: %v",
	MimeFailed:      "xdg-mime: %v",
	CloseTitle:      "Close %s",
	CloseAllTitle:   "Close all %d windows of %s",
	CloseDetail:     "%s · Unsaved work can be lost if the app does not ask first.",
	OpenFileTitle:   "Open %s",
	OpenURLTitle:    "Open %s",
	OpenURLDetail:   "In your default %s app. The page is on the internet.",
	DefaultTitle:    "Make %s the default for %s",
	DefaultDetail:   "%s → %s",
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
