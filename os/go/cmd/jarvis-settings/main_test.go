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

// TestBinaryListsSettingsTools runs the real loop with no system bus and
// no Wayland session: tools/list still works.
func TestBinaryListsSettingsTools(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = []string{"JARVIS_RUN_MAIN=1", "HOME=" + t.TempDir(), "DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent"}
	cmd.Stdin = strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if n := strings.Count(string(out), `"risk":`); n != 19+1 { // 19 tools plus jarvis.describe
		t.Errorf("jarvis-settings serves %d entries, want 19 tools plus jarvis.describe", n)
	}
	for _, want := range []string{`"name":"settings.get"`, `"name":"settings.keyboard"`, `"risk":"confirm"`, `"name":"users.add"`, `"risk":"password"`, `"name":"jarvis.describe"`, `"name":"users.list"`, `"name":"disks.list"`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("output lacks %s:\n%s", want, out)
		}
	}
}

// TestRestoreWithoutSavedScalesIsANoOp: the login hook must never fail a
// session that never changed a scale.
func TestRestoreWithoutSavedScalesIsANoOp(t *testing.T) {
	cmd := exec.Command(os.Args[0], "restore")
	cmd.Env = []string{"JARVIS_RUN_MAIN=1", "HOME=" + t.TempDir()}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}
