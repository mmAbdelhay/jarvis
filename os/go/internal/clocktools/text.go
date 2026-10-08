package clocktools

// text is every user-facing string of jarvis-clock (M1 contracts §6.5).
var text = struct {
	Summary      string // notification title
	DefaultLabel string // notification body when no label is given
}{
	Summary:      "Jarvis timer",
	DefaultLabel: "Time is up",
}
