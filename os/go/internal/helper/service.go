// Package helper is jarvis-helper, the root service. Service holds every
// decision (validate → authorize → check existence → run) with no D-Bus in
// sight, so all of it is unit tested on any OS; dbus.go is a thin adapter.
package helper

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// ErrDenied is what an Authorizer returns (wrapped) to refuse a caller.
var ErrDenied = errors.New("not authorized")

// Authorizer decides whether the D-Bus caller may perform a polkit action.
type Authorizer interface {
	Authorize(ctx context.Context, sender, action string) error
}

// Timeouts per operation.
const (
	installTimeout = 30 * time.Minute
	updateTimeout  = 5 * time.Minute
	restartTimeout = 90 * time.Second
	queryTimeout   = 60 * time.Second
	// ListsMaxAge is how old /var/lib/apt/lists may be before an install
	// refreshes it (contracts §6.4): a live ISO built days ago would 404.
	ListsMaxAge = 6 * time.Hour
)

// isProtected reports whether pkg belongs to Jarvis OS itself (jarvisd,
// jarvis-shell, jarvis-pkg, ...). A removal whose apt-get simulation would
// take any of them is refused (contracts §6.3): apt removes reverse
// dependencies, so this also catches every package a jarvis-* package
// depends on, while the confirm card only named what the user asked for.
func isProtected(pkg string) bool {
	return pkg == "jarvisd" || strings.HasPrefix(pkg, "jarvis-")
}

// Service implements the five helper methods.
type Service struct {
	Run  execx.Runner
	Auth Authorizer
	Now  func() time.Time
	// ListsAge returns how long ago the APT lists were refreshed; an error
	// (including ErrNoLists) counts as stale. See AptListsAge.
	ListsAge func() (time.Duration, error)

	mu       sync.Mutex // one apt/flatpak/systemctl operation at a time
	busy     atomic.Int32
	lastDone atomic.Int64 // unix nanos of the last finished call
}

func refuse(name, format string, a ...any) error {
	return &helperapi.Error{Name: name, Message: fmt.Sprintf(format, a...)}
}

func invalidErr(err error) error { return refuse(helperapi.ErrInvalid, "%v", err) }

// begin marks the service busy; the returned func marks it idle again.
func (s *Service) begin() func() {
	s.busy.Add(1)
	return func() {
		s.lastDone.Store(s.Now().UnixNano())
		s.busy.Add(-1)
	}
}

// IdleFor reports how long the service has had nothing to do (0 while busy).
// main uses it to exit after a few idle minutes; D-Bus activation restarts it.
func (s *Service) IdleFor(now time.Time) time.Duration {
	if s.busy.Load() > 0 {
		return 0
	}
	last := s.lastDone.Load()
	if last == 0 {
		return now.Sub(time.Time{}) // never used since start: idle forever
	}
	return now.Sub(time.Unix(0, last))
}

func (s *Service) authorize(ctx context.Context, sender, action string) error {
	if err := s.Auth.Authorize(ctx, sender, action); err != nil {
		return refuse(helperapi.ErrDenied, "not authorized: %v", err)
	}
	return nil
}

// run executes one command and turns it into an Outcome. stderr is redacted
// in full before it is cut to the tail, so a secret is never half-kept.
func (s *Service) run(ctx context.Context, timeout time.Duration, name string, args ...string) helperapi.Outcome {
	res, err := s.Run.Run(ctx, execx.Cmd{Name: name, Args: args, Timeout: timeout})
	if err != nil {
		return helperapi.Outcome{OK: false, ExitCode: -1, StderrTail: tail(redact.String(err.Error()))}
	}
	return helperapi.Outcome{OK: res.ExitCode == 0, ExitCode: int32(res.ExitCode), StderrTail: tail(redact.String(string(res.Stderr)))}
}

func tail(s string) string {
	if len(s) <= helperapi.StderrTailMax {
		return s
	}
	s = s[len(s)-helperapi.StderrTailMax:]
	for len(s) > 0 && !utf8.RuneStart(s[0]) {
		s = s[1:]
	}
	return s
}

// refreshAptLists runs apt-get update when the indices are stale. Failure is
// not fatal: the install that follows reports the real problem.
func (s *Service) refreshAptLists(ctx context.Context) {
	if s.ListsAge != nil {
		if age, err := s.ListsAge(); err == nil && age <= ListsMaxAge {
			return
		}
	}
	s.run(ctx, updateTimeout, "apt-get", "update", "-q")
}

// AptInstall installs Debian packages.
func (s *Service) AptInstall(ctx context.Context, sender string, names []string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.AptNames(names); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionPackages); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshAptLists(ctx)
	for _, n := range names {
		res, err := s.Run.Run(ctx, execx.Cmd{Name: "apt-cache", Args: []string{"show", "--no-all-versions", "--", n}, Timeout: queryTimeout})
		if err != nil || res.ExitCode != 0 || !showsPackage(string(res.Stdout), n) {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not available from Debian", n)
		}
	}
	// --no-remove: apt-get aborts rather than remove anything (a conflict
	// could otherwise take network-manager or a jarvis-* package with it;
	// contracts §6 #3 protects those).
	args := append([]string{"install", "-y", "--no-install-recommends", "--no-remove", "--"}, names...)
	return s.run(ctx, installTimeout, "apt-get", args...), nil
}

// showsPackage reports whether apt-cache show output holds a stanza for
// exactly name. apt-get reads an operand it cannot resolve exactly as a regex
// (and a trailing '-' as "remove"), and apt-cache show answers such operands
// with other packages' stanzas, so "any stanza" is not "name exists".
func showsPackage(out, name string) bool {
	for _, p := range parse.AptShow(out) {
		if p.Name == name {
			return true
		}
	}
	return false
}

// AptRemove removes installed Debian packages, unless the removal would take
// a protected package with it.
func (s *Service) AptRemove(ctx context.Context, sender string, names []string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.AptNames(names); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionPackages); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range names {
		res, err := s.Run.Run(ctx, execx.Cmd{Name: "dpkg-query", Args: []string{"-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--", n}, Timeout: queryTimeout})
		st := parse.DpkgQuery(string(res.Stdout))
		if err != nil || res.ExitCode != 0 || len(st) == 0 || !st[0].Installed {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not installed", n)
		}
	}
	sim, err := s.Run.Run(ctx, execx.Cmd{Name: "apt-get", Args: append([]string{"-s", "remove", "--"}, names...), Timeout: queryTimeout})
	if err != nil || sim.ExitCode != 0 {
		return helperapi.Outcome{OK: false, ExitCode: int32(sim.ExitCode), StderrTail: tail(redact.String(string(sim.Stderr)))}, nil
	}
	for _, p := range parse.AptSimulatedRemovals(string(sim.Stdout)) {
		if isProtected(p) {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "removing %s would also remove %s, which Jarvis OS needs", strings.Join(names, ", "), p)
		}
	}
	return s.run(ctx, installTimeout, "apt-get", append([]string{"remove", "-y", "--"}, names...)...), nil
}

// FlatpakInstall installs apps from the flathub remote only.
func (s *Service) FlatpakInstall(ctx context.Context, sender string, refs []string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.FlatpakRefs(refs); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionPackages); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range refs {
		res, err := s.Run.Run(ctx, execx.Cmd{Name: "flatpak", Args: []string{"remote-info", "--system", "flathub", r}, Timeout: queryTimeout})
		if err == nil && res.ExitCode == 0 {
			continue
		}
		if helperapi.LooksOffline(string(res.Stderr)) {
			// Not "not found": the network is down. Report it as a failed
			// run so the caller can say "offline".
			return helperapi.Outcome{OK: false, ExitCode: int32(res.ExitCode), StderrTail: tail(redact.String(string(res.Stderr)))}, nil
		}
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not available from Flathub", r)
	}
	args := append([]string{"install", "--system", "-y", "flathub"}, refs...)
	return s.run(ctx, installTimeout, "flatpak", args...), nil
}

// FlatpakRemove uninstalls system-wide Flatpak apps.
func (s *Service) FlatpakRemove(ctx context.Context, sender string, refs []string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.FlatpakRefs(refs); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionPackages); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range refs {
		res, err := s.Run.Run(ctx, execx.Cmd{Name: "flatpak", Args: []string{"info", "--system", r}, Timeout: queryTimeout})
		if err != nil || res.ExitCode != 0 {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not installed system-wide", r)
		}
	}
	args := append([]string{"uninstall", "--system", "-y"}, refs...)
	return s.run(ctx, installTimeout, "flatpak", args...), nil
}

// RestartUnit restarts one allowlisted system unit.
func (s *Service) RestartUnit(ctx context.Context, sender string, name string) (helperapi.Outcome, error) {
	defer s.begin()()
	unit, err := validate.RestartableUnit(name)
	if errors.Is(err, validate.ErrNotAllowed) {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%v", err)
	}
	if err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionServices); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	svc := unit + ".service"
	res, err := s.Run.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"show", "-p", "LoadState", "--value", "--", svc}, Timeout: queryTimeout})
	if err != nil || strings.TrimSpace(string(res.Stdout)) == "not-found" {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not installed on this system", svc)
	}
	return s.run(ctx, restartTimeout, "systemctl", "restart", "--", svc), nil
}

// ErrNoLists means the APT lists directory holds no index files.
var ErrNoLists = errors.New("no APT package lists")

// AptListsAge returns a ListsAge func over the APT lists directory; main
// passes os.DirFS("/var/lib/apt/lists") and time.Now. The age is that of the
// newest index file. "lock" and subdirectories ("partial", "auxfiles") are
// not indices; no index at all is ErrNoLists, which counts as stale.
func AptListsAge(lists fs.FS, now func() time.Time) func() (time.Duration, error) {
	return func() (time.Duration, error) {
		entries, err := fs.ReadDir(lists, ".")
		if err != nil {
			return 0, err
		}
		var newest time.Time
		for _, e := range entries {
			if e.IsDir() || e.Name() == "lock" {
				continue
			}
			if info, err := e.Info(); err == nil && info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
		if newest.IsZero() {
			return 0, ErrNoLists
		}
		return now().Sub(newest), nil
	}
}
