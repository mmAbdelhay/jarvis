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
	UpgradeOne                  string // id, from, to, "Debian" | "Debian, security" | "Flathub"
	UpgradeUnknown              string // id, where (versions could not be read)
	UpgradeMany                 string // count, ids
	UpgradeLine                 string // id, from, to, source, security note
	UpgradeLineUnknown          string // id, source, security note
	SecuritySuffix              string // appended to the source in the title
	SecurityNote                string // appended to the detail line
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

	UpgradeOne:         "Upgrade %s %s → %s (%s)",
	UpgradeUnknown:     "Upgrade %s (%s)",
	UpgradeMany:        "Upgrade %d apps: %s",
	UpgradeLine:        "%s %s → %s from %s%s. Nothing is removed.",
	UpgradeLineUnknown: "%s: newest version from %s%s. Nothing is removed.",
	SecuritySuffix:     ", security",
	SecurityNote:       " (security update)",
}

// registryText is every string jarvis-pkg puts on a registry card
// (Rafiq M2.5 contracts §3). English only; the M4 Arabic pass translates it.
var registryText = struct {
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
	Separator     string
}{
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
}
