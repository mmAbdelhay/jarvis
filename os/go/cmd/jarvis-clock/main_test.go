package main

import (
	"os"
	"os/exec"
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

func TestBinaryListsClockTools(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "JARVIS_RUN_MAIN=1")
	cmd.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n" +
			`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"clock.now","arguments":{"timezone":"Africa/Cairo"}}}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	for _, want := range []string{`"name":"jarvis-clock"`, `"name":"clock.now"`, `"name":"clock.timer"`, `"name":"jarvis.describe"`, `"timezone":"Africa/Cairo"`} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %s:\n%s", want, s)
		}
	}
}
