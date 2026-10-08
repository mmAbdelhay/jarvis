package admintools

import "github.com/mmAbdelhay/jarvis/os/go/internal/i18n"

// adminCard is every string the users and disks tools put on a card (M1
// contracts §6.5, Rafiq M4 contracts §3). These are password-tier cards:
// the Arabic must say exactly what the English says.
type adminCard struct {
	AddTitle, AddTitleFull, AddDetail       string
	RemoveTitle, RemoveKeep, RemoveDelete   string
	FormatTitle, FormatDetail, UnknownDrive string
	DriveSize                               string // drive name, size in GB
	MountTitle, UnmountTitle, MountDetail   string
	Password                                string
}

var cardText = i18n.NewTable("jarvis-settings/admin",
	adminCard{
		AddTitle:     "Add user %s",
		AddTitleFull: "Add user %s (%s)",
		AddDetail:    "A standard account without administrator rights, with the password you choose.",
		RemoveTitle:  "Remove user %s",
		RemoveKeep:   "Their home folder is kept.",
		RemoveDelete: "Their home folder and all their files are deleted.",
		FormatTitle:  "Erase and format %s as %s",
		FormatDetail: "Everything on %s is lost.",
		UnknownDrive: "this drive",
		DriveSize:    "%s, %.0f GB",
		MountTitle:   "Open the drive %s",
		UnmountTitle: "Safely remove the drive %s",
		MountDetail:  "Removable drive",
		Password:     " An administrator password is asked every time.",
	},
	adminCard{
		AddTitle:     "إضافة المستخدم %s",
		AddTitleFull: "إضافة المستخدم %s (%s)",
		AddDetail:    "حساب عادي دون صلاحيات المدير، بكلمة المرور التي تختارها.",
		RemoveTitle:  "حذف المستخدم %s",
		RemoveKeep:   "سيُحتفظ بمجلده الشخصي.",
		RemoveDelete: "سيُحذف مجلده الشخصي وكل ملفاته.",
		FormatTitle:  "مسح %s وتهيئته بنظام %s",
		FormatDetail: "سيضيع كل ما على %s.",
		UnknownDrive: "هذا القرص",
		DriveSize:    "%s، %.0f غيغابايت",
		MountTitle:   "فتح القرص %s",
		UnmountTitle: "إخراج القرص %s بأمان",
		MountDetail:  "قرص قابل للإزالة",
		Password:     " تُطلب كلمة مرور المدير في كل مرة.",
	},
)

// errText holds error messages; they go to the model and stay English.
var errText = struct{ BadPartition string }{
	BadPartition: "%q is not a USB or SD drive or partition like /dev/sdb1",
}
