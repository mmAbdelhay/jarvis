package diagtools

import "github.com/mmAbdelhay/jarvis/os/go/internal/i18n"

// diagCard is every string jarvis-diag puts on a confirm card (M1
// contracts §6.5, Rafiq M4 contracts §3). Error messages are not here:
// they go to the model, which explains them in the user's language.
type diagCard struct {
	RestartTitle     string // unit
	RestartUserTitle string // unit
	RestartDefault   string
	RestartEffect    map[string]string // allowlisted unit → what the user will notice
	ConnectTitle     string            // connection name
	ConnectDetail    string            // connection name (%q)
	WifiTitle        string            // SSID (%q)
	WifiDetail       string
	RadioTitle       string
	RadioDetail      string
}

var cardText = i18n.NewTable("jarvis-diag/card",
	diagCard{
		RestartTitle:     "Restart %s",
		RestartUserTitle: "Restart your %s service",
		RestartDefault:   "The service will stop and start again.",
		RestartEffect: map[string]string{
			"NetworkManager":   "The network will drop for a few seconds.",
			"wpa_supplicant":   "Wi-Fi will disconnect and reconnect.",
			"systemd-resolved": "Name lookups pause for a moment.",
			"bluetooth":        "Bluetooth devices will reconnect.",
			"cups":             "Print jobs in progress may restart.",
			"docker":           "Running containers will stop and start again.",
		},
		ConnectTitle:  "Connect to %s",
		ConnectDetail: "Bring up the saved network connection %q.",
		WifiTitle:     "Connect to Wi-Fi %q",
		WifiDetail:    "Jarvis will join this network. If it needs a password, type it here; it goes straight to NetworkManager and is never shown to the assistant.",
		RadioTitle:    "Turn Wi-Fi on",
		RadioDetail:   "The Wi-Fi radio is switched off in software; this switches it back on.",
	},
	diagCard{
		RestartTitle:     "إعادة تشغيل %s",
		RestartUserTitle: "إعادة تشغيل خدمتك %s",
		RestartDefault:   "ستتوقف الخدمة ثم تعمل من جديد.",
		RestartEffect: map[string]string{
			"NetworkManager":   "سينقطع الاتصال بالشبكة لبضع ثوانٍ.",
			"wpa_supplicant":   "سينقطع الواي فاي ثم يعود للاتصال.",
			"systemd-resolved": "سيتوقف تحويل أسماء المواقع إلى عناوين للحظات.",
			"bluetooth":        "ستعيد أجهزة البلوتوث الاتصال.",
			"cups":             "قد تبدأ مهام الطباعة الجارية من جديد.",
			"docker":           "ستتوقف الحاويات العاملة ثم تعمل من جديد.",
		},
		ConnectTitle:  "الاتصال بالشبكة %s",
		ConnectDetail: "تفعيل اتصال الشبكة المحفوظ %q.",
		WifiTitle:     "الاتصال بشبكة الواي فاي %q",
		WifiDetail:    "سينضم جارفيس إلى هذه الشبكة. إن احتاجت إلى كلمة مرور فاكتبها هنا؛ فهي تذهب مباشرة إلى مدير الشبكة ولا تُعرض على المساعد أبدًا.",
		RadioTitle:    "تشغيل الواي فاي",
		RadioDetail:   "الواي فاي مُطفأ برمجيًا، وهذا يعيد تشغيله.",
	},
)
