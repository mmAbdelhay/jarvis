package filestools

import "github.com/mmAbdelhay/jarvis/os/go/internal/i18n"

// writeCard is every string jarvis-files' write tools put on a confirm
// card (M1 contracts §6.5, Rafiq M4 contracts §3).
type writeCard struct {
	MoveTitle, CopyTitle, RenameTitle, MkdirTitle, TrashTitle, RestoreTitle string // base, place
	TrashDetail, RestoreDetail, UndoTitle, UndoDetail, Cannot               string
	PathChange                                                              string `i18n:"keep"` // from, to: only an arrow between two values
}

var writeCardText = i18n.NewTable("jarvis-files/card",
	writeCard{
		MoveTitle:     "Move %s to %s",
		CopyTitle:     "Copy %s to %s",
		RenameTitle:   "Rename %s to %s",
		MkdirTitle:    "Create folder %s",
		TrashTitle:    "Move %s to the trash",
		RestoreTitle:  "Restore %s from the trash",
		TrashDetail:   "%s · You can restore it from the trash, or say \"undo\".",
		RestoreDetail: "Back to %s",
		UndoTitle:     "Undo the last file change",
		UndoDetail:    "%d change(s) are reversed. Files changed since are left as they are.",
		Cannot:        "This will be refused: %s",
		PathChange:    "%s → %s",
	},
	writeCard{
		MoveTitle:     "نقل %s إلى %s",
		CopyTitle:     "نسخ %s إلى %s",
		RenameTitle:   "إعادة تسمية %s إلى %s",
		MkdirTitle:    "إنشاء المجلد %s",
		TrashTitle:    "نقل %s إلى سلة المهملات",
		RestoreTitle:  "استعادة %s من سلة المهملات",
		TrashDetail:   "%s · يمكنك استعادته من سلة المهملات، أو قل «تراجع».",
		RestoreDetail: "إعادته إلى %s",
		UndoTitle:     "التراجع عن آخر تغيير في الملفات",
		UndoDetail:    "سيُعكَس %d من التغييرات. الملفات التي تغيّرت بعد ذلك تبقى كما هي.",
		Cannot:        "سيُرفض هذا: %s",
		PathChange:    "%s ← %s",
	},
)

// writeErr holds the write tools' error messages; they go to the model
// and stay English (Rafiq M4 contracts §3).
var writeErr = struct {
	BadTrashList, BadItems, BadItem, BadJournal, UnknownJournal string
}{
	BadTrashList:   "query is at most 100 characters and limit is 1 to 100",
	BadItems:       "items must hold 1 to 200 entries",
	BadItem:        "every item needs a from path of at most 4096 characters",
	BadJournal:     "journalId must be the id a file tool returned",
	UnknownJournal: "that file change was already undone or is too old to undo",
}
