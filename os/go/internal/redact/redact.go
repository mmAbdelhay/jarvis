// Package redact removes secrets from text before it leaves a Jarvis OS
// process (design §6.3). It is one table of patterns: a match is replaced by
// "[redacted:<kind>]" and the rest of the line is kept, because a partly
// secret log line is still evidence. IP and MAC addresses are deliberately
// NOT redacted — diagnosis needs them. Walking structured results is the MCP
// server's job (internal/mcp), so no tool can forget it.
package redact

import "regexp"

// Pattern is one secret shape. When Keep is true the regexp's first group is
// a label (e.g. "password=") that stays in the output; only the value goes.
type Pattern struct {
	Kind string
	Re   *regexp.Regexp
	Keep bool
}

// Patterns is applied in order. Order matters: the PEM block goes first so a
// key body is never half-eaten by a token pattern, Anthropic keys before the
// generic sk- shape, the Authorization header before the bare Bearer form.
// A value that already starts with "[" is not re-redacted by the key=value
// pattern, so String is idempotent ("psk=[redacted:wifi_psk]" stays put).
var Patterns = []Pattern{
	{Kind: "private_key", Re: regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)`)},
	{Kind: "anthropic_key", Re: regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{16,}`)},
	{Kind: "api_key", Re: regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}`)},
	{Kind: "github_token", Re: regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{30,}`)},
	{Kind: "github_pat", Re: regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{22,}`)},
	{Kind: "slack_token", Re: regexp.MustCompile(`\bxox[bap]-[A-Za-z0-9-]{10,}`)},
	{Kind: "aws_key", Re: regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)},
	{Kind: "jwt", Re: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}`)},
	{Kind: "authorization", Re: regexp.MustCompile(`(?i)(\bauthorization\s*:\s*)[^\r\n]+`), Keep: true},
	{Kind: "bearer", Re: regexp.MustCompile(`(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]{16,}`), Keep: true},
	{Kind: "wifi_psk", Re: regexp.MustCompile(`(?i)(\b(?:802-11-wireless-security|wifi-sec)\.psk\s*[:=]\s*)\S+`), Keep: true},
	{Kind: "secret", Re: regexp.MustCompile(`(?i)((?:^|[^A-Za-z0-9])(?:password|passwd|secret|token|api[_-]?key|psk)\s*=\s*)("[^"]*"|'[^']*'|[^\s&;,\[][^\s&;,]*)`), Keep: true},
}

// String returns s with every secret replaced.
func String(s string) string {
	for _, p := range Patterns {
		repl := "[redacted:" + p.Kind + "]"
		if p.Keep {
			repl = "${1}" + repl
		}
		s = p.Re.ReplaceAllString(s, repl)
	}
	return s
}
