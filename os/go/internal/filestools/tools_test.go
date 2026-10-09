package filestools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func call(t *testing.T, d Deps, name, args string) (map[string]any, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			v, err := tool.Call(context.Background(), json.RawMessage(args))
			if err != nil {
				return nil, err
			}
			b, _ := json.Marshal(v)
			var m map[string]any
			json.Unmarshal(b, &m)
			return m, nil
		}
	}
	t.Fatalf("no tool %s", name)
	return nil, nil
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

func write(t *testing.T, root, rel string, data []byte) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// homeTree builds a small home folder with private corners and escapes.
func homeTree(t *testing.T) (home, outside string) {
	home, outside = t.TempDir(), t.TempDir()
	write(t, home, "Documents/Report 2026.txt", []byte("Quarterly report\n"))
	write(t, home, "Documents/report-draft.md", []byte("# Draft\n"))
	write(t, home, "Documents/photo.png", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00"))
	write(t, home, "Projects/big.log", []byte(strings.Repeat("line of log text\n", 2000)))
	write(t, home, "Projects/server.key", []byte("KEY"))
	write(t, home, "Projects/.git/report.txt", []byte("hidden"))
	write(t, home, ".ssh/id_rsa", []byte("PRIVATE"))
	write(t, home, "Keys/id_ed25519", []byte("PRIVATE"))
	write(t, outside, "secret.txt", []byte("outside"))
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(home, "escape.txt")))
	must(t, os.Symlink(filepath.Join(home, ".ssh", "id_rsa"), filepath.Join(home, "Documents", "link-to-key")))
	must(t, os.Symlink(filepath.Join(home, "Documents"), filepath.Join(home, "Docs")))
	return home, outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func paths(m map[string]any) []string {
	out := []string{}
	for _, r := range m["results"].([]any) {
		out = append(out, r.(map[string]any)["path"].(string))
	}
	return out
}

func TestToolsMatchContract(t *testing.T) {
	var got []string
	for _, tool := range Tools(Deps{}) {
		if tool.Risk != mcp.RiskSafe || tool.Hidden || len(tool.Secrets) != 0 {
			t.Errorf("%s must be a plain safe tool (contracts §3)", tool.Name)
		}
		got = append(got, tool.Name)
	}
	if !reflect.DeepEqual(got, []string{"files.search", "files.preview"}) {
		t.Fatalf("tools %v", got)
	}
	if Manifest.ID != "jarvis-files" || Manifest.Permissions.Network || len(Manifest.Permissions.Paths) != 0 {
		t.Fatalf("manifest %+v", Manifest)
	}
}

func TestSearchFindsByNameAndSkipsPrivateThings(t *testing.T) {
	home, _ := homeTree(t)
	d := Deps{Home: home}
	m, err := call(t, d, "files.search", `{"query":"report"}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(m); !reflect.DeepEqual(got, []string{"~/Documents/Report 2026.txt", "~/Documents/report-draft.md"}) {
		t.Fatalf("report: %v", got)
	}
	r0 := m["results"].([]any)[0].(map[string]any)
	if r0["kind"] != "file" || r0["sizeBytes"].(float64) != 17 || r0["name"] != "Report 2026.txt" {
		t.Fatalf("hit %v", r0)
	}
	if _, err := time.Parse(time.RFC3339, r0["modified"].(string)); err != nil {
		t.Fatalf("modified: %v", err)
	}
	for _, q := range []string{"id_rsa", "id_ed25519", "server", "escape", "secret", "link-to-key"} {
		m, _ := call(t, d, "files.search", `{"query":"`+q+`"}`)
		if got := paths(m); len(got) != 0 {
			t.Errorf("%s must find nothing, found %v", q, got)
		}
	}
	m, _ = call(t, d, "files.search", `{"query":"documents"}`)
	if got := paths(m); !reflect.DeepEqual(got, []string{"~/Documents"}) {
		t.Fatalf("folders: %v", got)
	}
	m, _ = call(t, d, "files.search", `{"query":"draft","path":"~/Documents"}`)
	if got := paths(m); !reflect.DeepEqual(got, []string{"~/Documents/report-draft.md"}) {
		t.Fatalf("scoped: %v", got)
	}
}

func TestSearchCapsAndRefusals(t *testing.T) {
	home, _ := homeTree(t)
	m, _ := call(t, Deps{Home: home}, "files.search", `{"query":"report","limit":1}`)
	if len(paths(m)) != 1 || m["truncated"] != true {
		t.Fatalf("limit: %v", m)
	}
	m, _ = call(t, Deps{Home: home, MaxVisit: 2}, "files.search", `{"query":"report"}`)
	if m["truncated"] != true {
		t.Fatalf("visit cap: %v", m)
	}
	for args, want := range map[string]mcp.Code{
		`{"query":"x","path":"~/.ssh"}`:             mcp.CodeDenied,
		`{"query":"x","path":"~/../"}`:              mcp.CodeInvalid,
		`{"query":"x","path":"/etc"}`:               mcp.CodeInvalid,
		`{"query":"x","path":"~/nope"}`:             mcp.CodeNotFound,
		`{"query":"x","path":"~/Projects/big.log"}`: mcp.CodeInvalid,
		`{"query":""}`:                              mcp.CodeInvalid,
		`{"query":"x","limit":0}`:                   mcp.CodeInvalid,
	} {
		if _, err := call(t, Deps{Home: home}, "files.search", args); codeOf(err) != want {
			t.Errorf("%s: %v, want %s", args, err, want)
		}
	}
	if _, err := call(t, Deps{Home: ""}, "files.search", `{"query":"x"}`); codeOf(err) != mcp.CodeFailed {
		t.Errorf("no HOME: %v", err)
	}
}

func TestPreviewText(t *testing.T) {
	home, _ := homeTree(t)
	m, err := call(t, Deps{Home: home}, "files.preview", `{"path":"~/Documents/Report 2026.txt"}`)
	if err != nil {
		t.Fatal(err)
	}
	if m["path"] != "~/Documents/Report 2026.txt" || m["text"] != "Quarterly report\n" || m["binary"] != false || m["truncated"] != false || m["sizeBytes"].(float64) != 17 {
		t.Fatalf("preview %v", m)
	}
	if !strings.HasPrefix(m["mime"].(string), "text/plain") {
		t.Fatalf("mime %v", m["mime"])
	}
	m, _ = call(t, Deps{Home: home}, "files.preview", `{"path":"~/Docs/report-draft.md"}`)
	if m["text"] != "# Draft\n" {
		t.Fatalf("through a symlink inside home: %v", m)
	}
	m, _ = call(t, Deps{Home: home}, "files.preview", `{"path":"~/Projects/big.log","maxBytes":256}`)
	if m["truncated"] != true || len(m["text"].(string)) != 256 {
		t.Fatalf("cap: truncated=%v len=%d", m["truncated"], len(m["text"].(string)))
	}
	m, _ = call(t, Deps{Home: home}, "files.preview", `{"path":"~/Documents/photo.png"}`)
	if m["binary"] != true || m["text"] != "" {
		t.Fatalf("binary: %v", m)
	}
}

func TestPreviewRefusesEscapesAndPrivateFiles(t *testing.T) {
	home, _ := homeTree(t)
	for args, want := range map[string]mcp.Code{
		`{"path":"~/escape.txt"}`:               mcp.CodeDenied, // symlink out of $HOME
		`{"path":"~/Documents/link-to-key"}`:    mcp.CodeDenied, // symlink into ~/.ssh
		`{"path":"~/.ssh/id_rsa"}`:              mcp.CodeDenied,
		`{"path":"~/Keys/id_ed25519"}`:          mcp.CodeDenied,
		`{"path":"~/Projects/server.key"}`:      mcp.CodeDenied,
		`{"path":"~/Projects/.git/report.txt"}`: mcp.CodeDenied,
		`{"path":"~/missing.txt"}`:              mcp.CodeNotFound,
		`{"path":"~/Documents"}`:                mcp.CodeInvalid,
		`{"path":"/etc/passwd"}`:                mcp.CodeInvalid,
		`{"path":"~/Documents/../../x"}`:        mcp.CodeInvalid,
		`{"path":"~/a","maxBytes":10}`:          mcp.CodeInvalid,
	} {
		if _, err := call(t, Deps{Home: home}, "files.preview", args); codeOf(err) != want {
			t.Errorf("%s: %v, want %s", args, err, want)
		}
	}
}

func TestPreviewDoesNotHangOnAFifo(t *testing.T) {
	home := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(home, "pipe"), 0o600); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := call(t, Deps{Home: home}, "files.preview", `{"path":"~/pipe"}`)
		done <- err
	}()
	select {
	case err := <-done:
		if codeOf(err) != mcp.CodeInvalid {
			t.Fatalf("fifo: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("files.preview hung on a FIFO")
	}
}
