package helper

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
)

// PasswordVerifier checks a user's password against the system's accounts
// (Rafiq M3 contracts §5.5). A wrong password is ErrBadPassword; any other
// error means the check could not be made, which also refuses.
type PasswordVerifier interface {
	Verify(ctx context.Context, user, password string) error
}

// ErrBadPassword is a password that does not match.
var ErrBadPassword = errors.New("wrong password")

// PAMVerifier verifies with pam_unix's own checker, /usr/sbin/unix_chkpwd,
// which pam_unix itself runs: it reads the NUL-terminated password on stdin
// and exits 0 when it matches the shadow entry. Run as root it may check any
// user. argv is "<user> nonull" (unix_chkpwd needs exactly 3 args), so an
// empty-password account never verifies. The password travels only over
// stdin, never in argv or the environment.
//
// DEVIATION from Rafiq M3 contracts §5.5 (open, for the coordinator): §5.5
// names the PAM service `jarvis-admin`. This is not a PAM conversation, so
// /etc/pam.d/jarvis-admin is never read and pam_faillock, pam_faildelay,
// PAM audit records and sssd/LDAP accounts are bypassed; only local shadow
// accounts verify. The plan forbids what a real conversation needs here (a
// cgo build of jarvis-helper, a new module dependency, files outside os/go),
// and the helper's own 3-failures-per-5-minutes limit below stands in for
// pam_faillock.
type PAMVerifier struct{ Run execx.Runner }

// Verify implements PasswordVerifier.
func (v PAMVerifier) Verify(ctx context.Context, user, password string) error {
	res, err := v.Run.Run(ctx, execx.Cmd{Name: "unix_chkpwd", Args: []string{user, "nonull"}, Stdin: []byte(password + "\x00"), Timeout: 10 * time.Second})
	if err != nil {
		return err
	}
	switch res.ExitCode {
	case 0:
		return nil
	case pamAuthErr:
		return ErrBadPassword
	default:
		// PAM_SYSTEM_ERR, PAM_USER_UNKNOWN, ...: the check could not be made.
		// Not a wrong password, so it does not count toward the lockout.
		return fmt.Errorf("unix_chkpwd exited %d", res.ExitCode)
	}
}

// pamAuthErr is PAM_AUTH_ERR, unix_chkpwd's exit status for a wrong password.
const pamAuthErr = 7

const (
	maxFailures = 3
	failWindow  = 5 * time.Minute
	lockFor     = 5 * time.Minute
)

type failState struct {
	times       []time.Time
	lockedUntil time.Time
}
