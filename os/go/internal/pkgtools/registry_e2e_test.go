package pkgtools

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry/registrytest"
)

// buildClock compiles cmd/jarvis-clock for this machine.
func buildClock(t *testing.T) []byte {
	t.Helper()
	if testing.Short() {
		t.Skip("builds a binary")
	}
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go toolchain not on PATH")
	}
	out := filepath.Join(t.TempDir(), "server")
	cmd := exec.Command(gobin, "build", "-o", out, "github.com/mmAbdelhay/jarvis/os/go/cmd/jarvis-clock")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// runRegistered starts a registered server the way jarvisd would (minus
// the sandbox) and returns its answers to tools/list and one tools/call.
func runRegistered(t *testing.T, regPath, callLine string) string {
	t.Helper()
	b, err := os.ReadFile(regPath)
	if err != nil {
		t.Fatal(err)
	}
	var reg registry.Registration
	if err := json.Unmarshal(b, &reg); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(reg.Command[0], reg.Command[1:]...)
	cmd.Env = []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %v: %v", reg.Command, err)
	}
	stdin.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" + callLine + "\n"))
	var out strings.Builder
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		out.WriteString(sc.Text() + "\n")
		if strings.Contains(sc.Text(), `"id":2`) {
			break
		}
	}
	stdin.Close()
	cmd.Wait()
	return out.String()
}

func TestEndToEndInstallRunUpgradeRefusedRemove(t *testing.T) {
	bin := buildClock(t)
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	v1 := fr.entry("jarvis-clock", "Clock", "Current time in any time zone, and desktop timers.", registry.TierOfficial, "0.3.0",
		artifactBytes(t, bin), "clock.now", "clock.timer")
	fr.publish(t, s, "2026-10-09T08:00:00Z", v1)
	d, home := registryDeps(t, fr, s)

	if _, err := call(t, d, "registry.install", `{"id":"jarvis-clock","version":"0.3.0"}`); err != nil {
		t.Fatal(err)
	}
	regPath := filepath.Join(home, ".config/jarvis/mcp.d/jarvis-clock.json")
	out := runRegistered(t, regPath, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"clock.now","arguments":{"timezone":"Asia/Tokyo"}}}`)
	for _, want := range []string{`"name":"clock.now"`, `"name":"clock.timer"`, `"timezone":"Asia/Tokyo"`, `"isError":false`} {
		if !strings.Contains(out, want) {
			t.Fatalf("installed server output lacks %s:\n%s", want, out)
		}
	}

	// A newer index pins 0.4.0, but the host serves tampered bytes.
	v2 := fr.entry("jarvis-clock", "Clock", "Current time in any time zone, and desktop timers.", registry.TierOfficial, "0.4.0",
		artifactBytes(t, bin), "clock.now", "clock.timer")
	fr.publish(t, s, "2026-10-10T08:00:00Z", v1, v2)
	fr.put("/artifacts/jarvis-clock-0.4.0.tar.gz", artifactBytes(t, append([]byte("#!/bin/sh\necho pwned\n"), bin[:64]...)))
	if _, err := call(t, d, "registry.install", `{"id":"jarvis-clock","version":"0.4.0"}`); code(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered upgrade: %v", err)
	}
	out = runRegistered(t, regPath, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"clock.now","arguments":{}}}`)
	if !strings.Contains(out, `"isError":false`) {
		t.Fatalf("0.3.0 must still run after the refused upgrade:\n%s", out)
	}

	if _, err := call(t, d, "registry.remove", `{"id":"jarvis-clock"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(regPath); !os.IsNotExist(err) {
		t.Fatal("registration left behind")
	}
	if _, err := os.Stat(filepath.Join(home, ".local/share/jarvis/mcp/jarvis-clock")); !os.IsNotExist(err) {
		t.Fatal("files left behind")
	}
}
