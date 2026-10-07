package pkgtools

// cardText is every string jarvis-pkg puts on a confirm card. M1 is
// English only; the M4 Arabic pass translates this table and nothing else
// (contracts §6.5). Error messages are not here: they go to the model,
// which explains them in the user's language.
var cardText = struct {
	InstallOne, InstallMany     string // %s name | %d count, %s names
	RemoveOne, RemoveMany       string
	SourceDebian, SourceFlathub string
	InstallLine                 string // id, version, source, download size
	RemoveLine                  string // id, version, source, freed size
	LookupFailed                string // id, source, reason
	RemoveUnknown               string // id, source
}{
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
}
