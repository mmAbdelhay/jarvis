package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestMain lets the test binary act as jarvis-pkg itself, so the wiring in
// main() is exercised over real stdin/stdout without building anything.
func TestMain(m *testing.M) {
	if os.Getenv("JARVIS_RUN_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestBinaryAnswersInitializeAndListsTools(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "JARVIS_RUN_MAIN=1", "HOME="+t.TempDir())
	cmd.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	for _, want := range []string{`"protocolVersion":"2025-06-18"`, `"name":"pkg.install"`, `"name":"jarvis.describe"`, `"risk":"confirm"`,
		`"name":"registry.search"`, `"name":"registry.install"`, `"name":"registry.remove"`} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %s", want)
		}
	}
}
