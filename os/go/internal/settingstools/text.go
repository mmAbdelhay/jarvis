package settingstools

// text is every user-facing string of jarvis-settings' settings tools
// (M1 contracts §6.5): card titles and details, and errors.
var text = struct {
	Brightness, Volume, Mute, Unmute, VolumeMute                    string
	NightOn, NightOnUntil, NightOff                                 string
	WiFiOn, WiFiOff, BTOn, BTOff, Pair, Unpair                      string
	PairDetail, UnpairDetail                                        string
	AudioOut, Power, Scale, Keyboard, KeyboardVariant               string
	Transition, Unknown, On, Off, Now, Unavailable, NeedOne, BadKey string
}{
	Transition: "%s → %s", Unknown: "unknown", On: "on", Off: "off",
	Brightness:      "Set screen brightness to %d%%",
	Volume:          "Set volume to %d%%",
	Mute:            "Mute sound",
	Unmute:          "Unmute sound",
	VolumeMute:      "Set volume to %d%% and %s",
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
	Unavailable:     "%s is not available on this computer",
	NeedOne:         "give percent, muted or both",
	BadKey:          "unknown setting %q",
}
