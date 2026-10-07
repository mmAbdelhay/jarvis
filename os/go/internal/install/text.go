package install

// text is every user-facing string the backend produces: Review summary
// lines, warnings, step titles, refusal reasons and progress details. English
// only in M2; the M4 Arabic pass translates this table and nothing else.
var text = struct {
	ChoicesDecode        string
	DiskDecode           string
	UserDecode           string
	SecretsDecode        string
	InvalidLocale        string
	InvalidKeyboard      string
	InvalidTimezone      string
	InvalidUsername      string
	InvalidHostname      string
	InvalidFullName      string
	MissingModelID       string
	InvalidModel         string
	InvalidBrainKind     string
	InvalidBaseURL       string
	InvalidPassword      string
	MissingPassphrase    string
	UnexpectedPassphrase string
	InvalidPassphrase    string

	// Summary lines.
	EraseDisk, EraseCreate                      string
	AlongsideShrink, ESPReuse, ESPCreate        string
	ManualRoot, ManualESPKeep, ManualESPFormat  string
	ManualSwapKeep, ManualSwapFormat            string
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
	LabelPartition                                 string
	// Refusal reasons.
	NoUEFI, DiskTooSmall, Bitlocker, Hibernated, Dirty string
	LiveMedium                                         string
	AlongsideTooSmall, NoWindows                       string
	ManualNoRoot, ManualNoESP, ManualSmallESP          string
	ModelTooBigDisk, ModelTooBigRAM, ModelNeedsGPU     string
	// Progress details.
	Preflight, Cancelled, DiskChanged, ModelOffline string
	ModelWaiting, ModelDownloading, ModelDone       string
	ModelLater, Done                                string
	NoteSecureBootOff, NoteNoNVRAM                  string
}{
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
