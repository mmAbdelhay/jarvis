// Package homepath turns the "~/…" paths a model sends into real paths for
// the tools that change or open files (Rafiq M3 contracts §1): every path
// ends up inside $HOME after symlinks are followed, and no part of it is
// hidden (".ssh", ".config", ".local", …) or key-like ("id_rsa", "*.pem").
// Errors are *mcp.ToolError so tool code can return them as they are.
//
// Same-user races (swapping a folder for a symlink between the check and
// the use) are out of scope, as for every Jarvis tool (M2.5 contracts §7.2);
// the threat is a model asking for a path, not a process racing the disk.
package homepath

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

// MaxPath bounds one path as the model sends it.
const MaxPath = 4096

var sensitiveRe = regexp.MustCompile(`(?i)^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|.*\.(pem|key|p12|pfx|kdbx|keystore|jks|gpg|asc|ovpn|ppk)|wallet\.dat|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env))$`)

// Private reports whether a name is never touched: hidden names and
// key-like names (the same rule as jarvis-files' read side).
func Private(name string) bool {
	return strings.HasPrefix(name, ".") || sensitiveRe.MatchString(name)
}

// ValidName checks one path segment a tool may create or name.
func ValidName(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > 255 || strings.ContainsRune(name, '/') {
		return mcp.Errorf(mcp.CodeInvalid, "%q is not a valid file name", name)
	}
	if !utf8.ValidString(name) {
		return mcp.Errorf(mcp.CodeInvalid, "%q is not valid text", name)
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return mcp.Errorf(mcp.CodeInvalid, "%q contains control characters", name)
		}
	}
	if Private(name) {
		return mcp.Errorf(mcp.CodeDenied, "%q is private (a hidden or key file) and is never touched", name)
	}
	return nil
}

// Path is one resolved path.
type Path struct {
	Abs     string // real absolute path; parent folders' symlinks resolved, the last part kept as is
	Display string // "~/a/b", from Abs
	Link    bool   // the last part is a symlink (its target is inside $HOME)
	Target  string // for Link: the real target; otherwise Abs
	Exists  bool
}

// IsHome reports whether p is $HOME itself.
func (p Path) IsHome() bool { return p.Display == "~" }

// Resolver resolves paths under one home folder.
type Resolver struct {
	Home string // absolute $HOME
}

func (r Resolver) realHome() (string, error) {
	if r.Home == "" || !filepath.IsAbs(r.Home) {
		return "", mcp.Errorf(mcp.CodeFailed, "HOME is not set, so there is no home folder")
	}
	real, err := filepath.EvalSymlinks(r.Home)
	if err != nil {
		return "", mcp.Errorf(mcp.CodeFailed, "the home folder %s cannot be read: %v", r.Home, err)
	}
	return real, nil
}

// segments splits "~", "~/a/b" or an absolute path lexically under $HOME
// into checked parts.
func (r Resolver) segments(p string) ([]string, error) {
	if len(p) == 0 || len(p) > MaxPath || strings.ContainsRune(p, 0) {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%q is not a path", p)
	}
	var rel string
	switch {
	case p == "~" || p == "~/":
		return nil, nil
	case strings.HasPrefix(p, "~/"):
		rel = p[2:]
	case filepath.IsAbs(p) && r.Home != "" && (p == r.Home || strings.HasPrefix(p, strings.TrimSuffix(r.Home, "/")+"/")):
		rel = strings.TrimPrefix(strings.TrimPrefix(p, strings.TrimSuffix(r.Home, "/")), "/")
	default:
		return nil, mcp.Errorf(mcp.CodeInvalid, "%q: paths start with ~/ (your home folder)", p)
	}
	rel = strings.TrimSuffix(rel, "/")
	if rel == "" {
		return nil, nil
	}
	parts := strings.Split(rel, "/")
	for _, s := range parts {
		if s == "" || s == "." || s == ".." {
			return nil, mcp.Errorf(mcp.CodeInvalid, "%q has an empty, . or .. part", p)
		}
	}
	for _, s := range parts {
		if err := ValidName(s); err != nil {
			return nil, mcp.Errorf(mcp.AsToolError(err).Code, "%q: %s", p, mcp.AsToolError(err).Message)
		}
	}
	return parts, nil
}

// inside checks that real (already symlink-free) is home or under it and
// that no part below home is private.
func inside(home, real, shown string) error {
	rel, err := filepath.Rel(home, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel) {
		return mcp.Errorf(mcp.CodeDenied, "%q points outside your home folder", shown)
	}
	if rel == "." {
		return nil
	}
	for _, s := range strings.Split(filepath.ToSlash(rel), "/") {
		if Private(s) {
			return mcp.Errorf(mcp.CodeDenied, "%q leads into a private (hidden or key) location", shown)
		}
	}
	return nil
}

func display(home, abs string) string {
	rel, _ := filepath.Rel(home, abs)
	if rel == "." {
		return "~"
	}
	return "~/" + filepath.ToSlash(rel)
}

// Existing resolves a path that must exist. Folder symlinks along the way
// are followed; the last part is kept (moving a link moves the link), but
// when it is a link its target must also be inside $HOME and not private.
func (r Resolver) Existing(p string) (Path, error) {
	home, err := r.realHome()
	if err != nil {
		return Path{}, err
	}
	parts, err := r.segments(p)
	if err != nil {
		return Path{}, err
	}
	if len(parts) == 0 {
		return Path{Abs: home, Display: "~", Target: home, Exists: true}, nil
	}
	lexical := filepath.Join(append([]string{home}, parts...)...)
	parent, err := filepath.EvalSymlinks(filepath.Dir(lexical))
	if errors.Is(err, fs.ErrNotExist) {
		return Path{}, mcp.Errorf(mcp.CodeNotFound, "%q does not exist", p)
	}
	if err != nil {
		return Path{}, mcp.Errorf(mcp.CodeFailed, "%q: %v", p, err)
	}
	if err := inside(home, parent, p); err != nil {
		return Path{}, err
	}
	if st, err := os.Stat(parent); err != nil || !st.IsDir() {
		return Path{}, mcp.Errorf(mcp.CodeInvalid, "%q: %s is not a folder", p, display(home, parent))
	}
	abs := filepath.Join(parent, parts[len(parts)-1])
	st, err := os.Lstat(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return Path{}, mcp.Errorf(mcp.CodeNotFound, "%q does not exist", p)
	}
	if err != nil {
		return Path{}, mcp.Errorf(mcp.CodeFailed, "%q: %v", p, err)
	}
	out := Path{Abs: abs, Display: display(home, abs), Target: abs, Exists: true}
	if st.Mode()&fs.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(abs)
		if err != nil {
			return Path{}, mcp.Errorf(mcp.CodeNotFound, "%q is a broken link", p)
		}
		if err := inside(home, target, p); err != nil {
			return Path{}, err
		}
		out.Link, out.Target = true, target
	}
	return out, nil
}

// New resolves a path that may not exist yet (a destination). The deepest
// existing folder on the way is resolved and checked; the missing parts are
// checked by name. Exists says whether something is already there.
func (r Resolver) New(p string) (Path, error) {
	home, err := r.realHome()
	if err != nil {
		return Path{}, err
	}
	parts, err := r.segments(p)
	if err != nil {
		return Path{}, err
	}
	if len(parts) == 0 {
		return Path{Abs: home, Display: "~", Target: home, Exists: true}, nil
	}
	if ex, err := r.Existing(p); err == nil {
		return ex, nil
	} else if mcp.AsToolError(err).Code != mcp.CodeNotFound {
		return Path{}, err
	}
	// Walk up to the deepest existing ancestor.
	n := len(parts) - 1
	for ; n > 0; n-- {
		if _, err := os.Lstat(filepath.Join(append([]string{home}, parts[:n]...)...)); err == nil {
			break
		}
	}
	base, err := filepath.EvalSymlinks(filepath.Join(append([]string{home}, parts[:n]...)...))
	if err != nil {
		return Path{}, mcp.Errorf(mcp.CodeNotFound, "%q: a folder on the way is a broken link", p)
	}
	if err := inside(home, base, p); err != nil {
		return Path{}, err
	}
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		return Path{}, mcp.Errorf(mcp.CodeInvalid, "%q: %s is not a folder", p, display(home, base))
	}
	abs := filepath.Join(append([]string{base}, parts[n:]...)...)
	return Path{Abs: abs, Display: display(home, abs), Target: abs}, nil
}

// Display returns the "~/…" form of a real absolute path under $HOME.
func (r Resolver) Display(abs string) string {
	home, err := r.realHome()
	if err != nil {
		return abs
	}
	return display(home, abs)
}
