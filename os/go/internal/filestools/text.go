package filestools

// text is every user-facing string of jarvis-files (M1 contracts §6.5).
// They reach the model as error messages.
var text = struct {
	NoHome      string
	TildePaths  string // path
	BadPart     string // path
	Private     string // path
	Outside     string // path
	NotFound    string // path
	NotFolder   string // path
	NotFile     string // path
	BadQuery    string
	BadLimit    string
	BadMaxBytes string
}{
	NoHome:      "HOME is not set, so there is no home folder to read",
	TildePaths:  "%q: paths start with ~/ (your home folder)",
	BadPart:     "%q has an empty, . or .. part",
	Private:     "%q is private (a hidden or key file) and is never read",
	Outside:     "%q points outside your home folder",
	NotFound:    "%q does not exist",
	NotFolder:   "%q is not a folder",
	NotFile:     "%q is not a regular file",
	BadQuery:    "query must be 1 to 100 characters",
	BadLimit:    "limit must be 1 to 100",
	BadMaxBytes: "maxBytes must be 256 to 65536",
}
