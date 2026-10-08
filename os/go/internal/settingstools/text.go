package settingstools

import "github.com/mmAbdelhay/jarvis/os/go/internal/i18n"

// settingsCard is every string the settings tools put on a confirm card
// (M1 contracts §6.5, Rafiq M4 contracts §3).
type settingsCard struct {
	Brightness, Volume, Mute, Unmute, VolumeMute      string
	MuteWord, UnmuteWord                              string // VolumeMute's %s
	NightOn, NightOnUntil, NightOff                   string
	WiFiOn, WiFiOff, BTOn, BTOff, Pair, Unpair        string
	PairDetail, UnpairDetail                          string
	AudioOut, Power, Scale, Keyboard, KeyboardVariant string
	Now                                               string
	Transition                                        string            `i18n:"keep"` // "<previous> → <current>" (Rafiq M4 contracts §6.4)
	Unknown, On, Off, OnUntil, VolumeMuted            string            // transition values
	Yes, No                                           string            // pair state in a transition
	Profiles                                          map[string]string // power-profiles-daemon id → shown name
}

var cardText = i18n.NewTable("jarvis-settings/settings",
	settingsCard{
		Brightness:      "Set screen brightness to %d%%",
		Volume:          "Set volume to %d%%",
		Mute:            "Mute sound",
		Unmute:          "Unmute sound",
		VolumeMute:      "Set volume to %d%% and %s",
		MuteWord:        "mute",
		UnmuteWord:      "unmute",
		NightOn:         "Turn night light on",
		NightOnUntil:    "Turn night light on until %02d:00",
		NightOff:        "Turn night light off",
		WiFiOn:          "Turn Wi-Fi on",
		WiFiOff:         "Turn Wi-Fi off",
		BTOn:            "Turn Bluetooth on",
		BTOff:           "Turn Bluetooth off",
		Pair:            "Pair Bluetooth device %s",
		Unpair:          "Forget Bluetooth device %s",
		PairDetail:      "Put the device in pairing mode first.",
		UnpairDetail:    "It must be paired again to use it.",
		AudioOut:        "Play sound through %s",
		Power:           "Switch power mode to %s",
		Scale:           "Set %s display scale to %g",
		Keyboard:        "Switch keyboard layout to %s",
		KeyboardVariant: "Switch keyboard layout to %s (%s)",
		Now:             "Now: %s",
		Transition:      "%s → %s",
		Unknown:         "unknown",
		On:              "on",
		Off:             "off",
		OnUntil:         "on until %02d:00",
		VolumeMuted:     "%d%%, muted",
		Yes:             "true",
		No:              "false",
		Profiles:        map[string]string{"power-saver": "power-saver", "balanced": "balanced", "performance": "performance"},
	},
	settingsCard{
		Brightness:      "ضبط سطوع الشاشة على %d%%",
		Volume:          "ضبط مستوى الصوت على %d%%",
		Mute:            "كتم الصوت",
		Unmute:          "إلغاء كتم الصوت",
		VolumeMute:      "ضبط مستوى الصوت على %d%% و%s",
		MuteWord:        "كتمه",
		UnmuteWord:      "إلغاء كتمه",
		NightOn:         "تشغيل الإضاءة الليلية",
		NightOnUntil:    "تشغيل الإضاءة الليلية حتى الساعة %02d:00",
		NightOff:        "إيقاف الإضاءة الليلية",
		WiFiOn:          "تشغيل الواي فاي",
		WiFiOff:         "إيقاف الواي فاي",
		BTOn:            "تشغيل البلوتوث",
		BTOff:           "إيقاف البلوتوث",
		Pair:            "إقران جهاز البلوتوث %s",
		Unpair:          "نسيان جهاز البلوتوث %s",
		PairDetail:      "ضع الجهاز في وضع الإقران أولًا.",
		UnpairDetail:    "يجب إقرانه من جديد لاستخدامه.",
		AudioOut:        "تشغيل الصوت عبر %s",
		Power:           "تغيير وضع الطاقة إلى %s",
		Scale:           "ضبط تكبير الشاشة %s على %g",
		Keyboard:        "تغيير تخطيط لوحة المفاتيح إلى %s",
		KeyboardVariant: "تغيير تخطيط لوحة المفاتيح إلى %s (%s)",
		Now:             "الآن: %s",
		Transition:      "%s ← %s",
		Unknown:         "غير معروف",
		On:              "مفعّل",
		Off:             "متوقف",
		OnUntil:         "مفعّل حتى الساعة %02d:00",
		VolumeMuted:     "%d%%، مكتوم",
		Yes:             "نعم",
		No:              "لا",
		Profiles:        map[string]string{"power-saver": "توفير الطاقة", "balanced": "متوازن", "performance": "الأداء العالي"},
	},
)

// errText holds the settings tools' error messages. They go to the model,
// so they stay English (Rafiq M4 contracts §3).
var errText = struct {
	Unavailable, NeedOne, BadKey string
}{
	Unavailable: "%s is not available on this computer",
	NeedOne:     "give percent, muted or both",
	BadKey:      "unknown setting %q",
}
