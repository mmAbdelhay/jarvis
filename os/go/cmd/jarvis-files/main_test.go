package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("JARVIS_RUN_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// TestPreviewOverStdioIsRedacted runs the real server loop: a token in an
// ordinary text file never leaves the process.
func TestPreviewOverStdioIsRedacted(t *testing.T) {
	home := t.TempDir()
	token := "ghp_" + strings.Repeat("A1b2", 9)
	if err := os.WriteFile(filepath.Join(home, "notes.txt"), []byte("deploy with token: "+token+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "JARVIS_RUN_MAIN=1", "HOME="+home)
	cmd.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"files.preview","arguments":{"path":"~/notes.txt"}}}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	if strings.Contains(s, token) {
		t.Fatalf("token leaked:\n%s", s)
	}
	for _, want := range []string{`"name":"files.search"`, `"name":"files.preview"`, "[redacted:"} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %s:\n%s", want, s)
		}
	}
}
