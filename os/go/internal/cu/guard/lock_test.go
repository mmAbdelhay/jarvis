package guard

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func procWith(t *testing.T, exes map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for pid, exe := range exes {
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if exe != "" {
			if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
				t.Fatal(err)
			}
		}
	}
	return root
}

func TestLocked(t *testing.T) {
	exes := []string{"/usr/bin/jarvis-lock", "/usr/bin/swaylock"}
	cases := []struct {
		name  string
		procs map[string]string
		want  bool
	}{
		{"nothing", map[string]string{"1": "/usr/lib/systemd/systemd", "77": "/usr/bin/gimp"}, false},
		{"jarvis-lock", map[string]string{"1": "/usr/lib/systemd/systemd", "4242": "/usr/bin/jarvis-lock"}, true},
		{"swaylock", map[string]string{"9": "/usr/bin/swaylock"}, true},
		{"upgraded binary", map[string]string{"9": "/usr/bin/jarvis-lock (deleted)"}, true},
		{"not a pid", map[string]string{"self": "/usr/bin/jarvis-lock"}, false},
		{"other user (no exe link)", map[string]string{"12": ""}, false},
		{"lookalike path", map[string]string{"12": "/tmp/usr/bin/jarvis-lock"}, false},
	}
	for _, c := range cases {
		l := LockWatch{ProcRoot: procWith(t, c.procs), Exes: exes}
		if got := l.Locked(); got != c.want {
			t.Errorf("%s: Locked() = %v", c.name, got)
		}
	}
	if !(LockWatch{ProcRoot: "/nonexistent/proc", Exes: exes}).Locked() {
		t.Fatal("an unreadable /proc must count as locked")
	}
}

func TestPollFiresOncePerLock(t *testing.T) {
	root := procWith(t, map[string]string{"1": "/sbin/init"})
	l := LockWatch{ProcRoot: root, Exes: []string{"/usr/bin/jarvis-lock"}}
	var n atomic.Int32
	stop := make(chan struct{})
	defer close(stop)
	go l.Poll(5*time.Millisecond, stop, func() { n.Add(1) })
	lockDir := filepath.Join(root, "500")
	os.MkdirAll(lockDir, 0o755)
	os.Symlink("/usr/bin/jarvis-lock", filepath.Join(lockDir, "exe"))
	time.Sleep(60 * time.Millisecond)
	if n.Load() != 1 {
		t.Fatalf("fired %d times while locked", n.Load())
	}
	os.RemoveAll(lockDir)
	time.Sleep(30 * time.Millisecond)
	os.MkdirAll(lockDir, 0o755)
	os.Symlink("/usr/bin/jarvis-lock", filepath.Join(lockDir, "exe"))
	time.Sleep(60 * time.Millisecond)
	if n.Load() != 2 {
		t.Fatalf("a second lock fired %d", n.Load())
	}
}
