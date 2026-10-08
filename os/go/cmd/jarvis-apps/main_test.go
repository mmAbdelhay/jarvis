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

// TestBinaryListsAppTools: tools/list works with no Wayland session at all
// (jarvisd may start before labwc), and apps.windows then fails cleanly.
func TestBinaryListsAppTools(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = []string{"JARVIS_RUN_MAIN=1", "HOME=" + t.TempDir(), "XDG_RUNTIME_DIR=" + t.TempDir()}
	cmd.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apps.windows","arguments":{}}}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	for _, want := range []string{`"name":"apps.list"`, `"name":"apps.set_default"`, `"name":"jarvis.describe"`, `"isError":true`, `Rafiq desktop session`} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %s:\n%s", want, s)
		}
	}
}
