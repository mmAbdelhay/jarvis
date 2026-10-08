package filestools

// writeText is every user-facing string of jarvis-files' write tools
// (M1 contracts §6.5): confirm-card titles and details, and errors.
var writeText = struct {
	MoveTitle, CopyTitle, RenameTitle, MkdirTitle, TrashTitle, RestoreTitle string // base, place
	TrashDetail, RestoreDetail, UndoTitle, UndoDetail                       string
	Cannot, BadTrashList, BadItems, BadItem, BadJournal, UnknownJournal     string
}{
	MoveTitle:      "Move %s to %s",
	CopyTitle:      "Copy %s to %s",
	RenameTitle:    "Rename %s to %s",
	MkdirTitle:     "Create folder %s",
	TrashTitle:     "Move %s to the trash",
	RestoreTitle:   "Restore %s from the trash",
	TrashDetail:    "%s · You can restore it from the trash, or say \"undo\".",
	RestoreDetail:  "Back to %s",
	UndoTitle:      "Undo the last file change",
	UndoDetail:     "%d change(s) are reversed. Files changed since are left as they are.",
	Cannot:         "This will be refused: %s",
	BadTrashList:   "query is at most 100 characters and limit is 1 to 100",
	BadItems:       "items must hold 1 to 200 entries",
	BadItem:        "every item needs a from path of at most 4096 characters",
	BadJournal:     "journalId must be the id a file tool returned",
	UnknownJournal: "that file change was already undone or is too old to undo",
}
