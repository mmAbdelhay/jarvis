package clocktools

// text is every user-facing string of jarvis-clock (M1 contracts §6.5).
var text = struct {
	DefaultLabel string // notification body when no label is given
	// The notification title ("Jarvis timer") is jarvisd's TIMER_SUMMARY:
	// jarvisd starts the timer (registry-servers.ts).
}{
	DefaultLabel: "Time is up",
}
