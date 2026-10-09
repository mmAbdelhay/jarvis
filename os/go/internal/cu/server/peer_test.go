package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeProc(t *testing.T, pid, exe, cmdline string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, pid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cmdline"), []byte(cmdline), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

var jarvisd = Expected{Exe: "/usr/lib/jarvis/node/bin/node", Script: "/usr/lib/jarvis/daemon/jarvisd.mjs", UID: 1000}

func TestVerifyProc(t *testing.T) {
	good := "/usr/lib/jarvis/node/bin/node\x00/usr/lib/jarvis/daemon/jarvisd.mjs\x00run\x00"
	cases := []struct {
		name, exe, cmdline string
		uid                uint32
		ok                 bool
	}{
		{"jarvisd", "/usr/lib/jarvis/node/bin/node", good, 1000, true},
		{"other uid", "/usr/lib/jarvis/node/bin/node", good, 1001, false},
		{"system node", "/usr/bin/node", "/usr/bin/node\x00/usr/lib/jarvis/daemon/jarvisd.mjs\x00run\x00", 1000, false},
		{"other script", "/usr/lib/jarvis/node/bin/node", "node\x00/tmp/evil.mjs\x00", 1000, false},
		{"script as later arg", "/usr/lib/jarvis/node/bin/node", "node\x00-e\x00x\x00/usr/lib/jarvis/daemon/jarvisd.mjs\x00", 1000, false},
		{"deleted binary", "/usr/lib/jarvis/node/bin/node (deleted)", good, 1000, false},
		{"python", "/usr/bin/python3", "python3\x00x.py\x00", 1000, false},
	}
	for _, c := range cases {
		root := fakeProc(t, "4321", c.exe, c.cmdline)
		err := VerifyProc(root, 4321, c.uid, jarvisd)
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
	if err := VerifyProc(t.TempDir(), 1, 1000, jarvisd); err == nil {
		t.Fatal("a missing process passed")
	}
	noScript := Expected{Exe: "/opt/test/cu.test", UID: 1000}
	root := fakeProc(t, "77", "/opt/test/cu.test", "cu.test\x00")
	if err := VerifyProc(root, 77, 1000, noScript); err != nil {
		t.Fatalf("empty Script skips the argv check: %v", err)
	}
	if err := VerifyProc(root, 77, 1000, Expected{UID: 1000}); err == nil || !strings.Contains(err.Error(), "no expected") {
		t.Fatal("an empty Exe must never match")
	}
}
