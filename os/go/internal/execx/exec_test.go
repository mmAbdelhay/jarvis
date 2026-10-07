package execx

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// These tests run real /bin and /usr/bin programs present on both macOS and
// Debian (env, sh, sleep, head); they do not depend on any Linux tool.

func TestOSRunnerPassesOnlyTheGivenEnvironment(t *testing.T) {
	t.Setenv("JARVIS_SHOULD_NOT_LEAK", "1")
	r := &OSRunner{Env: []string{"PATH=" + FixedPath, "ONLY=yes"}}
	res, err := r.Run(context.Background(), Cmd{Name: "env"})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Fields(string(res.Stdout))
	if len(got) != 2 || got[0] != "PATH="+FixedPath || got[1] != "ONLY=yes" {
		t.Fatalf("child env = %q, want exactly PATH and ONLY", got)
	}
}

func TestOSRunnerReportsExitCodeWithoutError(t *testing.T) {
	r := &OSRunner{Env: BaseEnv()}
	res, err := r.Run(context.Background(), Cmd{Name: "sh", Args: []string{"-c", "echo oops >&2; exit 3"}})
	if err != nil {
		t.Fatalf("non-zero exit must not be an error, got %v", err)
	}
	if res.ExitCode != 3 || strings.TrimSpace(string(res.Stderr)) != "oops" {
		t.Fatalf("got exit %d stderr %q", res.ExitCode, res.Stderr)
	}
}

func TestOSRunnerArgvIsNeverShellParsed(t *testing.T) {
	r := &OSRunner{Env: BaseEnv()}
	res, err := r.Run(context.Background(), Cmd{Name: "printf", Args: []string{"%s", "$(echo pwned); touch /tmp/x"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Stdout) != "$(echo pwned); touch /tmp/x" {
		t.Fatalf("argument was altered: %q", res.Stdout)
	}
}

func TestOSRunnerTimesOut(t *testing.T) {
	r := &OSRunner{Env: BaseEnv()}
	start := time.Now()
	_, err := r.Run(context.Background(), Cmd{Name: "sleep", Args: []string{"5"}, Timeout: 100 * time.Millisecond})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("timeout did not stop the child promptly")
	}
}

func TestOSRunnerCapsOutput(t *testing.T) {
	r := &OSRunner{Env: BaseEnv(), MaxOutput: 1000}
	res, err := r.Run(context.Background(), Cmd{Name: "head", Args: []string{"-c", "100000", "/dev/zero"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Stdout) != 1000 {
		t.Fatalf("stdout len = %d, want 1000", len(res.Stdout))
	}
}

func TestOSRunnerFeedsStdin(t *testing.T) {
	r := &OSRunner{Env: BaseEnv()}
	res, err := r.Run(context.Background(), Cmd{Name: "head", Args: []string{"-c", "5"}, Stdin: []byte("hello world")})
	if err != nil || string(res.Stdout) != "hello" {
		t.Fatalf("got %q, %v", res.Stdout, err)
	}
}

func TestLookPathRefusesPathsAndUnknownPrograms(t *testing.T) {
	for _, name := range []string{"", "/bin/sh", "../sh", "./sh", "jarvis-no-such-program"} {
		if _, err := LookPath(name); err == nil {
			t.Errorf("LookPath(%q) succeeded", name)
		}
	}
}

func TestUserEnvKeepsOnlySessionVariables(t *testing.T) {
	vals := map[string]string{"HOME": "/home/jarvis", "XDG_RUNTIME_DIR": "/run/user/1000", "LD_PRELOAD": "/evil.so", "PATH": "/evil"}
	env := UserEnv(func(k string) string { return vals[k] })
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "LD_PRELOAD") || strings.Contains(joined, "/evil") {
		t.Fatalf("leaked: %q", env)
	}
	if !strings.Contains(joined, "HOME=/home/jarvis") || !strings.Contains(joined, "XDG_RUNTIME_DIR=/run/user/1000") {
		t.Fatalf("missing session vars: %q", env)
	}
}

func TestHelperEnvIsNonInteractive(t *testing.T) {
	if !strings.Contains(strings.Join(HelperEnv(), "\n"), "DEBIAN_FRONTEND=noninteractive") {
		t.Fatal("helper env must set DEBIAN_FRONTEND=noninteractive")
	}
}

func TestFakeReturnsRegisteredResultsAndRejectsOthers(t *testing.T) {
	f := (&Fake{}).On(OK("hi\n"), "echo", "hi")
	res, err := f.Run(context.Background(), Cmd{Name: "echo", Args: []string{"hi"}})
	if err != nil || string(res.Stdout) != "hi\n" {
		t.Fatalf("got %q %v", res.Stdout, err)
	}
	if _, err := f.Run(context.Background(), Cmd{Name: "echo", Args: []string{"bye"}}); err == nil {
		t.Fatal("unregistered argv must fail")
	}
	if !f.Ran("echo", "hi") || f.Ran("echo", "nope") {
		t.Fatal("Ran bookkeeping wrong")
	}
}
