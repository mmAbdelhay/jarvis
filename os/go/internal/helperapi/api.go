// Package helperapi is the shared vocabulary of jarvis-helper's D-Bus API
// (contracts §2): names, error names, polkit action IDs, the reply shape and
// the Helper interface that jarvis-pkg and jarvis-diag program against. The
// interface lives here, not in the client, so the tool packages can be built
// and tested against a fake before the D-Bus client exists.
package helperapi

import (
	"context"
	"strings"
	"time"
)

// D-Bus names (contracts §2).
const (
	BusName    = "os.jarvis.Helper1"
	ObjectPath = "/os/jarvis/Helper1"
	Interface  = "os.jarvis.Helper1"
)

// polkit action IDs (contracts §2).
const (
	ActionPackages = "os.jarvis.helper.packages"
	ActionServices = "os.jarvis.helper.services"
	ActionAdmin    = "os.jarvis.helper.admin" // reserved for future password tools
)

// D-Bus error names the helper returns for a refused call. A call that ran
// and failed is not an error: it returns ok=false with the exit code.
const (
	ErrInvalid    = "os.jarvis.Helper1.Error.Invalid"
	ErrNotFound   = "os.jarvis.Helper1.Error.NotFound"
	ErrDenied     = "os.jarvis.Helper1.Error.Denied"
	ErrNotAllowed = "os.jarvis.Helper1.Error.NotAllowed"
)

// PackageCallTimeout is the client's ceiling for one package call. It sits
// above the helper's worst case for one call (apt-get update 5 min +
// apt-cache show 1 min + install 30 min), so the helper, not the client,
// reports a hung apt-get.
const PackageCallTimeout = 38 * time.Minute

// StderrTailMax bounds the stderr tail in every reply (contracts §2: ≤ 4 KiB).
const StderrTailMax = 4096

// Outcome is every method's reply: (b ok, i exitCode, s stderrTail).
type Outcome struct {
	OK         bool
	ExitCode   int32
	StderrTail string // redacted, ≤ StderrTailMax bytes
}

// Error is a refused call. Name is one of the Err* names, or another D-Bus
// error name (e.g. org.freedesktop.DBus.Error.ServiceUnknown), or "" when the
// bus itself could not be reached.
type Error struct {
	Name    string
	Message string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Name
	}
	return e.Message
}

// Code maps the error to a contracts §1 error code.
func (e *Error) Code() string {
	switch e.Name {
	case ErrInvalid:
		return "invalid"
	case ErrNotFound:
		return "not_found"
	case ErrDenied, "org.freedesktop.DBus.Error.AccessDenied":
		return "denied"
	case ErrNotAllowed:
		return "not_allowed"
	default:
		return "failed"
	}
}

// Helper is jarvis-helper as seen by its callers.
type Helper interface {
	AptInstall(ctx context.Context, names []string) (Outcome, error)
	AptRemove(ctx context.Context, names []string) (Outcome, error)
	FlatpakInstall(ctx context.Context, refs []string) (Outcome, error)
	FlatpakRemove(ctx context.Context, refs []string) (Outcome, error)
	RestartUnit(ctx context.Context, name string) (Outcome, error)
	// AptUpgrade upgrades installed Debian packages only (M2 contracts §2).
	AptUpgrade(ctx context.Context, names []string) (Outcome, error)
	// FlatpakUpdate updates installed Flathub apps (M2 contracts §2).
	FlatpakUpdate(ctx context.Context, refs []string) (Outcome, error)
}

// LooksOffline reports whether apt/flatpak stderr says the network is down,
// so callers can return the typed "offline" error (design §10).
func LooksOffline(stderr string) bool {
	for _, s := range []string{
		"Temporary failure resolving", "Could not resolve", "Couldn't resolve host",
		"Network is unreachable", "No route to host", "Could not connect to",
		"Unable to connect", "Failed to connect", "Connection timed out",
	} {
		if strings.Contains(stderr, s) {
			return true
		}
	}
	return false
}
