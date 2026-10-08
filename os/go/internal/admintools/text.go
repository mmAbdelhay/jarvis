package admintools

// text is every user-facing string of the users and disks tools (M1
// contracts §6.5).
var text = struct {
	AddTitle, AddTitleFull, AddDetail       string
	RemoveTitle, RemoveKeep, RemoveDelete   string
	FormatTitle, FormatDetail, UnknownDrive string
	MountTitle, UnmountTitle, MountDetail   string
	Password, BadPartition                  string
}{
	AddTitle:     "Add user %s",
	AddTitleFull: "Add user %s (%s)",
	AddDetail:    "A standard account without administrator rights, with the password you choose.",
	RemoveTitle:  "Remove user %s",
	RemoveKeep:   "Their home folder is kept.",
	RemoveDelete: "Their home folder and all their files are deleted.",
	FormatTitle:  "Erase and format %s as %s",
	FormatDetail: "Everything on %s is lost.",
	UnknownDrive: "this drive",
	MountTitle:   "Open the drive %s",
	UnmountTitle: "Safely remove the drive %s",
	MountDetail:  "Removable drive",
	Password:     " An administrator password is asked every time.",
	BadPartition: "%q is not a USB or SD drive or partition like /dev/sdb1",
}
