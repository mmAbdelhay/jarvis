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
// Decided scope (recorded in docs/os/threat-model.md M28, replacing the
// `jarvis-admin` PAM service named in Rafiq M3 contracts §5.5): this is not a
// PAM conversation, so no /etc/pam.d file is read and none is shipped. Only
// local shadow accounts verify; pam_faillock, pam_faildelay, PAM audit
// records and sssd/LDAP accounts do not apply. The helper's own lockout
// (3 wrong passwords in 5 minutes, then 5 minutes refused, see lockedOut)
// replaces pam_faillock. A cgo libpam build of jarvis-helper would restore a
// real `jarvis-admin` conversation.
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

// lockedOut reports whether any user's admin-password lockout is still
// running at now. The lockout lives only in this process, so IdleFor treats
// it as busy: the helper never idle-exits (and is never re-activated with a
// clean slate) while a lockout holds, whatever main's idleExit is.
func (s *Service) lockedOut(now time.Time) bool {
	s.failMu.Lock()
	defer s.failMu.Unlock()
	for _, st := range s.fails {
		if now.Before(st.lockedUntil) {
			return true
		}
	}
	return false
}
