package webtools

// text is every user-facing string of jarvis-web (M1 contracts §6.5).
var text = struct {
	BadURL      string
	Credentials string
	BadMaxChars string
	Blocked     string // host
	Unreachable string // host, error
	NotText     string
}{
	BadURL:      "only http and https web addresses of at most 2048 characters can be fetched",
	Credentials: "web addresses with a user name or password are refused",
	BadMaxChars: "maxChars must be 1000 to 100000",
	Blocked:     "%s is a local or private network address; web.fetch only reads the public internet",
	Unreachable: "could not fetch %s: %v",
	NotText:     "not text",
}
