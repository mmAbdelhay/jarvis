// Package registry is the client side of the Jarvis MCP tool registry
// (Rafiq M2.5 contracts §3): the signed index, the artifact download and
// unpack, and the per-user install store that jarvisd reads. Every trust
// decision of the registry lives here, in plain Go with no MCP in it.
package registry

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Tier is a registry server's trust tier.
type Tier string

const (
	TierOfficial  Tier = "official"
	TierReviewed  Tier = "reviewed"
	TierCommunity Tier = "community"
)

// Runtime is how a server's entry point is started.
type Runtime string

const (
	RuntimeGoStatic Runtime = "go-static"
	RuntimeNode     Runtime = "node"
	RuntimePython   Runtime = "python"
)

// Artifact is where a server's archive lives and what it must hash to.
type Artifact struct {
	URL     string  `json:"url"`
	SHA256  string  `json:"sha256"`
	Runtime Runtime `json:"runtime"`
}

// Permissions are what the sandbox grants: network, and "~/"-prefixed
// folders the server may write.
type Permissions struct {
	Network bool     `json:"network"`
	Paths   []string `json:"paths"`
}

// ToolDecl is one tool a server declares, with its declared risk.
type ToolDecl struct {
	Name string `json:"name"`
	Risk string `json:"risk"`
}

// Entry is one RegistryEntry of contracts §3.
type Entry struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Tier        Tier        `json:"tier"`
	Version     string      `json:"version"`
	Artifact    Artifact    `json:"artifact"`
	Permissions Permissions `json:"permissions"`
	Tools       []ToolDecl  `json:"tools"`
}

// IndexFormat is the only index document version this code reads.
const IndexFormat = 1

// MaxIndexBytes bounds index.json.
const MaxIndexBytes = 1 << 20

// MaxIndexLifetime bounds validUntil - generatedAt (contracts §7.6).
const MaxIndexLifetime = 30 * 24 * time.Hour

// Index is index.json: {"version":1,"generatedAt":RFC3339,"entries":[...]}.
type Index struct {
	Version     int    `json:"version"`
	GeneratedAt string `json:"generatedAt"`
	// ValidUntil is the index expiry (contracts §7.6); required, so an old signed index cannot be replayed forever.
	// Task 3 refuses an index past it.
	ValidUntil string  `json:"validUntil"`
	Entries    []Entry `json:"entries"`
	// Rejected says why each dropped entry was dropped (never sent anywhere).
	Rejected []string `json:"-"`
}

// ErrInvalid wraps every validation failure.
var ErrInvalid = errors.New("registry: invalid")

// ErrNetwork wraps every failure to reach the registry or an artifact host.
var ErrNetwork = errors.New("registry: network")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

var (
	idRe      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	versionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+~-]{0,63}$`)
	shaRe     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	toolRe    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,31}(\.[A-Za-z0-9_-]{1,31}){0,3}$`)
	// A path part may not start with "." (no hidden folders, no "..").
	segRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.,+@-]{0,127}$`)
)

// reservedIDs are the built-in servers' names. jarvisd trusts those by
// name (M1 contracts §1), so no registry entry may take one.
var reservedIDs = map[string]bool{
	"jarvis-pkg": true, "jarvis-diag": true, "jarvis-helper": true,
	"jarvis-installer-backend": true, "jarvis-model-fetch": true,
	// Rafiq M3 built-ins. jarvis-files is not here: the official registry
	// build keeps that id (M2.5 contracts §3); the built-in one shadows it.
	"jarvis-settings": true, "jarvis-apps": true, "jarvis-wl": true,
}

// ValidID checks a registry id: also a folder and a file name.
func ValidID(s string) error {
	if !idRe.MatchString(s) {
		return invalid("%q is not a registry id", s)
	}
	if reservedIDs[s] {
		return invalid("%q is reserved for a built-in Jarvis server", s)
	}
	return nil
}

// ValidVersion checks a version: also a folder name.
func ValidVersion(s string) error {
	if !versionRe.MatchString(s) {
		return invalid("%q is not a version", s)
	}
	return nil
}

// ValidPath checks one writable path: "~/" then non-hidden parts.
func ValidPath(p string) error {
	if len(p) > 512 || !strings.HasPrefix(p, "~/") {
		return invalid("path %q must start with ~/", p)
	}
	rest := strings.TrimSuffix(p[2:], "/")
	if rest == "" {
		return invalid("path %q is the whole home folder", p)
	}
	for _, seg := range strings.Split(rest, "/") {
		if !segRe.MatchString(seg) {
			return invalid("path %q has a hidden, empty or unusual part %q", p, seg)
		}
	}
	return nil
}

// plainText allows printable text only: no control characters (so no
// terminal escapes) and no bidirectional overrides (so a card cannot be
// made to read backwards).
func plainText(s string, min, max int) bool {
	n := utf8.RuneCountInString(s)
	if !utf8.ValidString(s) || n < min || n > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return false
		}
	}
	return true
}

// Validate checks every field of e.
func (e Entry) Validate() error {
	if err := ValidID(e.ID); err != nil {
		return err
	}
	switch e.Tier {
	case TierOfficial, TierReviewed, TierCommunity:
	default:
		return invalid("%s: unknown tier %q", e.ID, e.Tier)
	}
	if strings.HasPrefix(e.ID, "jarvis-") && e.Tier != TierOfficial {
		return invalid("%s: the jarvis- prefix is for official servers", e.ID)
	}
	if err := ValidVersion(e.Version); err != nil {
		return fmt.Errorf("%s: %w", e.ID, err)
	}
	if !plainText(e.Name, 1, 80) {
		return invalid("%s: name must be 1 to 80 printable characters", e.ID)
	}
	if !plainText(e.Description, 0, 1000) {
		return invalid("%s: description must be at most 1000 printable characters", e.ID)
	}
	u, err := url.Parse(e.Artifact.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(e.Artifact.URL) > 2048 {
		return invalid("%s: artifact url must be a plain https URL", e.ID)
	}
	if !shaRe.MatchString(e.Artifact.SHA256) {
		return invalid("%s: artifact sha256 must be 64 lowercase hex digits", e.ID)
	}
	switch e.Artifact.Runtime {
	case RuntimeGoStatic, RuntimeNode, RuntimePython:
	default:
		return invalid("%s: unknown runtime %q", e.ID, e.Artifact.Runtime)
	}
	if len(e.Permissions.Paths) > 16 {
		return invalid("%s: at most 16 writable paths", e.ID)
	}
	seen := map[string]bool{}
	for _, p := range e.Permissions.Paths {
		if err := ValidPath(p); err != nil {
			return fmt.Errorf("%s: %w", e.ID, err)
		}
		if seen[p] {
			return invalid("%s: path %q listed twice", e.ID, p)
		}
		seen[p] = true
	}
	if len(e.Tools) == 0 || len(e.Tools) > 64 {
		return invalid("%s: must declare 1 to 64 tools", e.ID)
	}
	names := map[string]bool{}
	for _, t := range e.Tools {
		if !toolRe.MatchString(t.Name) || t.Name == "jarvis.describe" {
			return invalid("%s: %q is not a tool name", e.ID, t.Name)
		}
		if t.Risk != "safe" && t.Risk != "confirm" {
			return invalid("%s: tool %s has risk %q (safe or confirm only)", e.ID, t.Name, t.Risk)
		}
		if names[t.Name] {
			return invalid("%s: tool %s listed twice", e.ID, t.Name)
		}
		names[t.Name] = true
	}
	return nil
}

// normalize makes nil lists empty so they marshal as [] (contract shape).
func (e *Entry) normalize() {
	if e.Permissions.Paths == nil {
		e.Permissions.Paths = []string{}
	}
	if e.Tools == nil {
		e.Tools = []ToolDecl{}
	}
}

// ParseIndex reads index.json. A bad envelope refuses the document; a bad
// entry is dropped on its own (reason in Rejected), and so is a repeated
// id@version. Unknown fields are ignored so the format can grow.
func ParseIndex(b []byte) (*Index, error) {
	if len(b) > MaxIndexBytes {
		return nil, invalid("index is larger than %d bytes", MaxIndexBytes)
	}
	var raw struct {
		Version     int               `json:"version"`
		GeneratedAt string            `json:"generatedAt"`
		ValidUntil  string            `json:"validUntil"`
		Entries     []json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, invalid("index is not a JSON object: %v", err)
	}
	if raw.Version != IndexFormat {
		return nil, invalid("unsupported index format %d", raw.Version)
	}
	gen, err := time.Parse(time.RFC3339, raw.GeneratedAt)
	if err != nil {
		return nil, invalid("index generatedAt %q is not RFC 3339", raw.GeneratedAt)
	}
	if raw.ValidUntil == "" {
		return nil, invalid("index has no validUntil")
	}
	vu, err := time.Parse(time.RFC3339, raw.ValidUntil)
	if err != nil {
		return nil, invalid("index validUntil %q is not RFC 3339", raw.ValidUntil)
	}
	if vu.After(gen.Add(MaxIndexLifetime)) {
		return nil, invalid("index validUntil is more than 30 days after generatedAt")
	}
	ix := &Index{Version: raw.Version, GeneratedAt: raw.GeneratedAt, ValidUntil: raw.ValidUntil, Entries: []Entry{}}
	seen := map[string]bool{}
	for i, r := range raw.Entries {
		var e Entry
		if err := json.Unmarshal(r, &e); err != nil {
			ix.Rejected = append(ix.Rejected, fmt.Sprintf("entry %d: %v", i, err))
			continue
		}
		e.normalize()
		if err := e.Validate(); err != nil {
			ix.Rejected = append(ix.Rejected, fmt.Sprintf("entry %d: %v", i, err))
			continue
		}
		key := e.ID + "@" + e.Version
		if seen[key] {
			ix.Rejected = append(ix.Rejected, fmt.Sprintf("entry %d: %s listed twice", i, key))
			continue
		}
		seen[key] = true
		ix.Entries = append(ix.Entries, e)
	}
	return ix, nil
}

// Find returns the entry with exactly this id and version.
func (ix *Index) Find(id, version string) (Entry, bool) {
	for _, e := range ix.Entries {
		if e.ID == id && e.Version == version {
			return e, true
		}
	}
	return Entry{}, false
}

// Generated is GeneratedAt as a time (ParseIndex already checked it).
func (ix *Index) Generated() time.Time {
	t, _ := time.Parse(time.RFC3339, ix.GeneratedAt)
	return t
}

// Expiry is ValidUntil as a time; ParseIndex guarantees it is set.
func (ix *Index) Expiry() time.Time {
	t, _ := time.Parse(time.RFC3339, ix.ValidUntil)
	return t
}
