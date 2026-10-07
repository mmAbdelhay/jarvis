package diagtools

// cardText is every string jarvis-diag puts on a confirm card. M1 is
// English only; the M4 Arabic pass translates this table and nothing else
// (contracts §6.5). Error messages are not here: they go to the model,
// which explains them in the user's language.
var cardText = struct {
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
}{
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
}
