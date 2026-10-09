// Package execx runs external programs the only way Jarvis OS tools may:
// a fixed program name resolved against a fixed PATH, an argv array (never a
// shell string), and a complete environment chosen by the caller (nothing is
// inherited). Every tool takes a Runner so tests swap in Fake.
package execx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// FixedPath is the only PATH a child process ever sees. A user's own PATH
// could put a look-alike `nmcli` first; the tools must not follow it.
const FixedPath = "/usr/sbin:/usr/bin:/sbin:/bin"

// DefaultTimeout bounds a command that sets no Timeout of its own.
const DefaultTimeout = 30 * time.Second

// DefaultMaxOutput caps each of stdout and stderr.
const DefaultMaxOutput = 8 << 20

// ErrTimeout is returned when a command outlives its timeout.
var ErrTimeout = errors.New("command timed out")

// Cmd is one program invocation.
type Cmd struct {
	Name    string        // bare program name, e.g. "nmcli"; resolved against FixedPath
	Args    []string      // argv[1:]; never parsed by a shell
	Stdin   []byte        // nil means no stdin
	Timeout time.Duration // 0 means DefaultTimeout
}

// Result is what a finished program produced. A non-zero exit is a Result,
// not an error: callers decide what an exit code means.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int // -1 when the program did not run to completion
}

// Runner runs a Cmd. The error is non-nil only when the program could not be
// started, timed out, or the context was cancelled.
type Runner interface {
	Run(ctx context.Context, c Cmd) (Result, error)
}

// OSRunner runs real processes.
type OSRunner struct {
	Env       []string // the complete child environment
	MaxOutput int      // per stream; 0 means DefaultMaxOutput
}

// BaseEnv is the environment every child gets. C.UTF-8 keeps tool output in
// the English the parsers expect; TZ=UTC makes systemctl timestamps parseable.
func BaseEnv() []string {
	return []string{"PATH=" + FixedPath, "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TZ=UTC"}
}

// UserEnv is BaseEnv plus the few session variables user-side tools need
// (`systemctl --user` needs the runtime dir and session bus; flatpak needs HOME).
func UserEnv(getenv func(string) string) []string {
	env := BaseEnv()
	for _, k := range []string{"HOME", "USER", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
		if v := getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// HelperEnv is the root helper's environment: no interactive prompts from
// apt or debconf, ever.
func HelperEnv() []string {
	return append(BaseEnv(), "DEBIAN_FRONTEND=noninteractive", "HOME=/root")
}

// LookPath resolves name against FixedPath only.
func LookPath(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, '/') {
		return "", fmt.Errorf("execx: program name must be bare, got %q", name)
	}
	for _, dir := range filepath.SplitList(FixedPath) {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("execx: %s not found in %s", name, FixedPath)
}

// Run implements Runner.
func (r *OSRunner) Run(ctx context.Context, c Cmd) (Result, error) {
	path, err := LookPath(c.Name)
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	max := r.MaxOutput
	if max == 0 {
		max = DefaultMaxOutput
	}
	stdout := &capBuffer{max: max}
	stderr := &capBuffer{max: max}
	cmd := exec.CommandContext(ctx, path, c.Args...)
	cmd.Env = append([]string{}, r.Env...)
	cmd.Dir = "/"
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = 2 * time.Second
	if c.Stdin != nil {
		cmd.Stdin = bytes.NewReader(c.Stdin)
	}
	runErr := cmd.Run()
	res := Result{Stdout: stdout.buf.Bytes(), Stderr: stderr.buf.Bytes(), ExitCode: -1}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			return Result{Stdout: res.Stdout, Stderr: res.Stderr, ExitCode: -1}, fmt.Errorf("%s: %w", c.Name, ErrTimeout)
		}
		return Result{Stdout: res.Stdout, Stderr: res.Stderr, ExitCode: -1}, ctxErr
	}
	var exitErr *exec.ExitError
	if runErr != nil && !errors.As(runErr, &exitErr) {
		return res, runErr
	}
	return res, nil
}

// capBuffer keeps the first max bytes and silently drops the rest, so a
// runaway command cannot exhaust memory.
type capBuffer struct {
	buf bytes.Buffer
	max int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}
