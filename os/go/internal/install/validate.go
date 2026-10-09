package install

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	localeRe   = regexp.MustCompile(`^[a-z]{2,3}(_[A-Z]{2})?(@[a-z]+)?\.UTF-8$`)
	keyboardRe = regexp.MustCompile(`^[a-z]{2,8}(\([a-z0-9_-]{1,32}\))?$`)
	tzRe       = regexp.MustCompile(`^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$`)
	userRe     = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	hostRe     = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
)

// reservedUsers are account names the target system already has or that
// Rafiq components use; useradd would fail or, worse, collide.
var reservedUsers = map[string]bool{
	"root": true, "daemon": true, "bin": true, "sys": true, "sync": true, "games": true, "man": true,
	"lp": true, "mail": true, "news": true, "uucp": true, "proxy": true, "www-data": true, "backup": true,
	"list": true, "irc": true, "_apt": true, "nobody": true, "messagebus": true, "polkitd": true,
	"_greetd": true, "greeter": true, "ollama": true, "jarvis": true, "admin": true, "sudo": true,
	"systemd-network": true, "systemd-timesync": true, "systemd-resolve": true, "avahi": true, "colord": true,
}

func noControl(s string) bool { return strings.IndexFunc(s, unicode.IsControl) < 0 }

// checkChoices validates every free-form field. Disk geometry and sizes are
// Plan's job; this is about input shape only.
func checkChoices(c Choices) error {
	switch {
	case !localeRe.MatchString(c.Locale):
		return invalidf(text.InvalidLocale, c.Locale)
	case !keyboardRe.MatchString(c.Keyboard):
		return invalidf(text.InvalidKeyboard, c.Keyboard)
	case !tzRe.MatchString(c.Timezone) || strings.Contains(c.Timezone, ".."):
		return invalidf(text.InvalidTimezone, c.Timezone)
	case !userRe.MatchString(c.User.Username) || reservedUsers[c.User.Username] || strings.HasPrefix(c.User.Username, "systemd-"):
		return invalidf(text.InvalidUsername, c.User.Username)
	case !hostRe.MatchString(c.User.Hostname):
		return invalidf(text.InvalidHostname, c.User.Hostname)
	case c.User.FullName == "" || utf8.RuneCountInString(c.User.FullName) > 100 || !utf8.ValidString(c.User.FullName) ||
		!noControl(c.User.FullName) || strings.ContainsAny(c.User.FullName, ":,=\\"):
		return invalidf("%s", text.InvalidFullName)
	}
	switch c.Brain.Kind {
	case "local":
		if c.Brain.ModelID == "" {
			return invalidf("%s", text.MissingModelID)
		}
	case "lan":
		if _, err := normalizeBaseURL(c.Brain.BaseURL); err != nil {
			return err
		}
		if c.Brain.Model == "" || len(c.Brain.Model) > 200 || !noControl(c.Brain.Model) {
			return invalidf("%s", text.InvalidModel)
		}
	case "cloud":
	default:
		return invalidf("%s", text.InvalidBrainKind)
	}
	return nil
}

// normalizeBaseURL applies jarvisd's parseBaseUrl rules (packages/wire
// os-control.ts): http(s), no credentials, no query or fragment, no
// trailing slash.
func normalizeBaseURL(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || len(s) > 2048 {
		return "", invalidf("%s", text.InvalidBaseURL)
	}
	return u.Scheme + "://" + u.Host + strings.TrimRight(u.EscapedPath(), "/"), nil
}

// checkSecrets validates the secrets against the plan: a LUKS passphrase
// exactly when encrypting, no control characters (chpasswd reads one line;
// cryptsetup --key-file=- reads every byte, so a newline would become part
// of a passphrase nobody can type at boot).
func checkSecrets(s Secrets, encrypt bool) error {
	if utf8.RuneCountInString(s.UserPassword) == 0 || utf8.RuneCountInString(s.UserPassword) > 1024 || !utf8.ValidString(s.UserPassword) || !noControl(s.UserPassword) {
		return invalidf("%s", text.InvalidPassword)
	}
	switch {
	case encrypt && s.LUKSPassphrase == nil:
		return invalidf("%s", text.MissingPassphrase)
	case !encrypt && s.LUKSPassphrase != nil:
		return invalidf("%s", text.UnexpectedPassphrase)
	case encrypt:
		p := *s.LUKSPassphrase
		if utf8.RuneCountInString(p) < 8 || utf8.RuneCountInString(p) > 512 || !utf8.ValidString(p) || !noControl(p) {
			return invalidf("%s", text.InvalidPassphrase)
		}
	}
	return nil
}
