package redact

import (
	"strings"
	"testing"
)

// One positive and at least one near-miss per pattern (design §11).
func TestPatterns(t *testing.T) {
	cases := []struct {
		kind, in, want string
	}{
		{"private_key", "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\ndone", "key:\n[redacted:private_key]\ndone"},
		{"private_key truncated block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow", "[redacted:private_key]"},
		{"private_key near-miss: certificate", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"},
		{"private_key near-miss: public key", "-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----"},

		{"anthropic_key", "using sk-ant-api03-AbCdEf0123456789xyz now", "using [redacted:anthropic_key] now"},
		{"anthropic_key near-miss", "sk-ant-short", "sk-ant-short"},

		{"api_key", "OPENAI sk-proj-AbCdEfGhIjKlMnOpQrSt12", "OPENAI [redacted:api_key]"},
		{"api_key near-miss: inside a word", "task-0123456789abcdefghijk", "task-0123456789abcdefghijk"},
		{"api_key near-miss: too short", "sk-12345", "sk-12345"},

		{"github_token", "ghp_0123456789abcdefghijABCDEFGHIJ012345 pushed", "[redacted:github_token] pushed"},
		{"github_token near-miss", "ghp_tooShort", "ghp_tooShort"},

		{"github_pat", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "[redacted:github_pat]"},
		{"github_pat near-miss", "github_pat_short", "github_pat_short"},

		{"slack_token", "xoxb-1234567890-abcdefghij", "[redacted:slack_token]"},
		{"slack_token near-miss", "xoxz-1234567890-abcdefghij", "xoxz-1234567890-abcdefghij"},

		{"aws_key", "id AKIAIOSFODNN7EXAMPLE ok", "id [redacted:aws_key] ok"},
		{"aws_key near-miss: short", "AKIAIOSFODNN7EXAMP", "AKIAIOSFODNN7EXAMP"},
		{"aws_key near-miss: inside a word", "XAKIAIOSFODNN7EXAMPLE", "XAKIAIOSFODNN7EXAMPLE"},

		{"jwt", "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end", "tok [redacted:jwt] end"},
		{"jwt near-miss: header only", "eyJhbGciOiJIUzI1NiJ9", "eyJhbGciOiJIUzI1NiJ9"},

		{"authorization", "> Authorization: Basic dXNlcjpwYXNz", "> Authorization: [redacted:authorization]"},
		{"authorization near-miss", "authorization failed for user jarvis", "authorization failed for user jarvis"},

		{"bearer", "curl -H 'X: Bearer abcdefghijklmnop1234'", "curl -H 'X: Bearer [redacted:bearer]'"},
		{"bearer near-miss", "the bearer of bad news", "the bearer of bad news"},

		{"wifi_psk", "802-11-wireless-security.psk:hunter2hunter2", "802-11-wireless-security.psk:[redacted:wifi_psk]"},
		{"wifi_psk keyfile", "wifi-sec.psk = hunter2hunter2", "wifi-sec.psk = [redacted:wifi_psk]"},
		{"wifi_psk near-miss", "802-11-wireless-security.key-mgmt:wpa-psk", "802-11-wireless-security.key-mgmt:wpa-psk"},

		{"secret", "login password=hunter2 ok", "login password=[redacted:secret] ok"},
		{"secret quoted", `client_secret="a b c" next`, `client_secret=[redacted:secret] next`},
		{"secret psk keyfile", "psk=correcthorse", "psk=[redacted:secret]"},
		{"secret near-miss: passwordless", "passwordless=true", "passwordless=true"},
		{"secret near-miss: prose", "password changed for jarvis", "password changed for jarvis"},
		{"secret near-miss: tokens count", "tokens=5", "tokens=5"},

		{"secret value starting with [", "password=[hunter2] ok", "password=[redacted:secret] ok"},
		{"secret value starting with [ unbracketed", "token=[abc next", "token=[redacted:secret] next"},
		{"secret json", `{"password": "hunter2", "user": "ali"}`, `{"password": [redacted:secret], "user": "ali"}`},
		{"secret json api_key", `{"api_key":"abc123def"}`, `{"api_key":[redacted:secret]}`},
		{"secret json escaped quote", `{"secret": "a\"b", "n": 1}`, `{"secret": [redacted:secret], "n": 1}`},
		{"secret json array value", `{"token": ["a", "b"], "n": 1}`, `{"token": [redacted:secret], "n": 1}`},
		{"secret json single-quoted", `{'passwd': 'x y'}`, `{'passwd': [redacted:secret]}`},
		{"secret yaml", "token: abc123\nuser: ali", "token: [redacted:secret]\nuser: ali"},
		{"secret yaml indented api-key", "  api-key: zzz", "  api-key: [redacted:secret]"},
		{"secret yaml psk", "psk: correcthorse", "psk: [redacted:secret]"},
		{"secret near-miss: yaml empty value keeps next line", "password:\nuser: ali", "password:\nuser: ali"},
		{"secret near-miss: json key with suffix", `{"token_count": 5}`, `{"token_count": 5}`},
		{"secret near-miss: plural key", "secrets: 3 loaded", "secrets: 3 loaded"},
		{"secret near-miss: passwordless yaml", "passwordless: true", "passwordless: true"},
		{"secret near-miss: key inside a word", "mytoken: abc", "mytoken: abc"},
		{"secret near-miss: no separator", `"password" "x"`, `"password" "x"`},

		{"addresses are kept", "eth0 192.168.1.20/24 aa:bb:cc:dd:ee:ff gw fe80::1", "eth0 192.168.1.20/24 aa:bb:cc:dd:ee:ff gw fe80::1"},
	}
	for _, c := range cases {
		if got := String(c.in); got != c.want {
			t.Errorf("%s:\n in   %q\n got  %q\n want %q", c.kind, c.in, got, c.want)
		}
	}
}

func TestEveryPatternHasAPositiveCase(t *testing.T) {
	// Guards the table: adding a pattern without a test case fails here.
	positives := map[string]string{
		"private_key":   "-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----",
		"anthropic_key": "sk-ant-api03-AbCdEf0123456789xyz",
		"api_key":       "sk-proj-AbCdEfGhIjKlMnOpQrSt12",
		"github_token":  "gho_0123456789abcdefghijABCDEFGHIJ012345",
		"github_pat":    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
		"slack_token":   "xoxp-1234567890-abcdefghij",
		"aws_key":       "AKIAIOSFODNN7EXAMPLE",
		"jwt":           "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3",
		"authorization": "Authorization: token abc",
		"bearer":        "Bearer abcdefghijklmnop1234",
		"wifi_psk":      "wifi-sec.psk:abcdefgh",
		"secret":        "passwd=abc",
	}
	for _, p := range Patterns {
		in, ok := positives[p.Kind]
		if !ok {
			t.Errorf("pattern %q has no positive case", p.Kind)
			continue
		}
		if !strings.Contains(String(in), "[redacted:"+p.Kind+"]") {
			t.Errorf("pattern %q did not fire on %q: %q", p.Kind, in, String(in))
		}
	}
}

func TestPartialLineIsRedactedNotDropped(t *testing.T) {
	in := "Oct 07 10:00:01 host app[42]: retrying with key sk-ant-api03-AbCdEf0123456789xyz for user alice"
	got := String(in)
	if got != "Oct 07 10:00:01 host app[42]: retrying with key [redacted:anthropic_key] for user alice" {
		t.Fatalf("got %q", got)
	}
}

func TestStringIsIdempotent(t *testing.T) {
	for _, in := range []string{
		"password=x Authorization: Bearer abcdefghijklmnop1234 sk-ant-api03-AbCdEf0123456789xyz",
		`{"password": "x", "token": ["a"], "api_key": 'k'}`,
		"token: [abc]\npsk: x\nwifi-sec.psk:abcdefgh",
	} {
		once := String(in)
		if twice := String(once); twice != once {
			t.Fatalf("not idempotent:\n%q\n%q", once, twice)
		}
	}
}

func TestOnlyFullMarkerIsSkipped(t *testing.T) {
	if got := String("password=[redacted:foo]bar"); strings.Contains(got, "bar") {
		t.Fatalf("value merely starting with a marker leaked: %q", got)
	}
	if got := String("password=[redacted:foo]"); got != "password=[redacted:foo]" {
		t.Fatalf("full marker was rewritten: %q", got)
	}
}
