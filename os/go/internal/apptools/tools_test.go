package apptools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/desktop"
	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// fakeWindows is a scripted compositor.
type fakeWindows struct {
	list      []wl.Window
	activated []string
	closed    []string
}

func (f *fakeWindows) Windows() ([]wl.Window, error) { return f.list, nil }
func (f *fakeWindows) Activate(id string) error      { f.activated = append(f.activated, id); return nil }
func (f *fakeWindows) CloseWindow(id string) error   { f.closed = append(f.closed, id); return nil }

func writeFile(t *testing.T, dir, rel, data string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

const (
	codeDesktop = "[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=/usr/share/code/code --unity-launch %F\nStartupWMClass=Code\nMimeType=text/plain;inode/directory;\nKeywords=vscode;editor;\n"
	ffDesktop   = "[Desktop Entry]\nType=Application\nName=Firefox ESR\nName[ar]=فايرفوكس\nExec=/usr/lib/firefox-esr/firefox-esr %u\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n"
	calcDesktop = "[Desktop Entry]\nType=Application\nName=Calculator\nExec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=gnome-calculator org.gnome.Calculator\n"
	htopDesktop = "[Desktop Entry]\nType=Application\nName=Htop\nExec=htop\nTerminal=true\n"
)

func deps(t *testing.T, run execx.Runner, win *fakeWindows) (Deps, string) {
	home, sys, flat := t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, sys, "code.desktop", codeDesktop)
	writeFile(t, sys, "firefox-esr.desktop", ffDesktop)
	writeFile(t, sys, "htop.desktop", htopDesktop)
	writeFile(t, flat, "org.gnome.Calculator.desktop", calcDesktop)
	writeFile(t, home, "Projects/site/index.html", "<p>hi</p>")
	writeFile(t, home, ".ssh/id_rsa", "k")
	d := Deps{
		Run:     run,
		Paths:   homepath.Resolver{Home: home},
		Dirs:    []desktop.Dir{{Path: flat, Source: "flatpak"}, {Path: sys, Source: "apt"}},
		Display: func() (string, error) { return "wayland-0", nil },
		NewID:   func() string { return "abcd1234" },
	}
	if win != nil {
		d.Windows = func() (Windows, error) { return win, nil }
	}
	return d, home
}

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

func describe(t *testing.T, d Deps, name, args string) (mcp.Description, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			return tool.Describe(context.Background(), json.RawMessage(args))
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}, nil
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

func TestToolsMatchContract(t *testing.T) {
	want := map[string]mcp.Risk{
		"apps.list": mcp.RiskSafe, "apps.windows": mcp.RiskSafe, "apps.open": mcp.RiskSafe, "apps.focus": mcp.RiskSafe,
		"apps.close": mcp.RiskConfirm, "apps.open_path": mcp.RiskSafe, "apps.open_url": mcp.RiskConfirm, "apps.set_default": mcp.RiskConfirm,
	}
	got := map[string]mcp.Risk{}
	for _, tool := range Tools(Deps{}) {
		got[tool.Name] = tool.Risk
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tools %v", got)
	}
	if err := (&mcp.Server{Name: "jarvis-apps", Tools: Tools(Deps{})}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestList(t *testing.T) {
	d, _ := deps(t, nil, nil)
	m, err := call(t, d, "apps.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, a := range m["apps"].([]any) {
		ids = append(ids, a.(map[string]any)["id"].(string)+"/"+a.(map[string]any)["source"].(string))
	}
	if !reflect.DeepEqual(ids, []string{"org.gnome.Calculator/flatpak", "firefox-esr/apt", "htop/apt", "code/apt"}) {
		t.Fatalf("apps %v", ids)
	}
	for q, want := range map[string]string{"vscode": "code", "فايرفوكس": "firefox-esr", "CALC": "org.gnome.Calculator"} {
		m, _ := call(t, d, "apps.list", `{"query":"`+q+`"}`)
		apps := m["apps"].([]any)
		if len(apps) != 1 || apps[0].(map[string]any)["id"] != want {
			t.Errorf("%s: %v", q, apps)
		}
	}
	m, _ = call(t, d, "apps.list", `{"limit":1}`)
	if m["truncated"] != true {
		t.Fatalf("limit: %v", m)
	}
}

func TestOpenLaunchesATransientService(t *testing.T) {
	prefix := []string{"--user", "--quiet", "--collect", "--unit=app-jarvis-code-abcd1234", "-p", "ExitType=cgroup", "--setenv=WAYLAND_DISPLAY=wayland-0", "--setenv=XDG_SESSION_TYPE=wayland", "--"}
	run := &execx.Fake{}
	d, home := deps(t, run, nil)
	real, _ := filepath.EvalSymlinks(filepath.Join(home, "Projects", "site"))
	run.On(execx.OK(""), "systemd-run", append(prefix, "/usr/share/code/code", "--unity-launch", real)...)
	m, err := call(t, d, "apps.open", `{"id":"code","paths":["~/Projects/site"]}`)
	if err != nil {
		t.Fatal(err)
	}
	if m["unit"] != "app-jarvis-code-abcd1234.service" || !reflect.DeepEqual(m["paths"], []any{"~/Projects/site"}) {
		t.Fatalf("result %v", m)
	}
	termArgs := append(append([]string{}, prefix...), "x-terminal-emulator", "-e", "htop")
	termArgs[3] = "--unit=app-jarvis-htop-abcd1234"
	run.On(execx.OK(""), "systemd-run", termArgs...)
	if _, err := call(t, d, "apps.open", `{"id":"htop"}`); err != nil {
		t.Fatalf("terminal app: %v", err)
	}
	for args, want := range map[string]mcp.Code{
		`{"id":"nope"}`: mcp.CodeNotFound,
		`{"id":"code","paths":["~/.ssh/id_rsa"]}`:              mcp.CodeDenied,
		`{"id":"code","paths":["/etc/passwd"]}`:                mcp.CodeInvalid,
		`{"id":"org.gnome.Calculator","paths":["~/Projects"]}`: mcp.CodeInvalid,
	} {
		if _, err := call(t, d, "apps.open", args); codeOf(err) != want {
			t.Errorf("%s: %v, want %s", args, err, want)
		}
	}
}

func TestWindowsFocusClose(t *testing.T) {
	win := &fakeWindows{list: []wl.Window{
		{ID: "w1", AppID: "Code", Title: "site — Visual Studio Code"},
		{ID: "w2", AppID: "firefox-esr", Title: "Inbox", Focused: true},
		{ID: "w3", AppID: "firefox-esr", Title: "News"},
	}}
	d, _ := deps(t, nil, win)
	m, err := call(t, d, "apps.windows", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	ws := m["windows"].([]any)
	if ws[0].(map[string]any)["desktopId"] != "code" || ws[1].(map[string]any)["desktopId"] != "firefox-esr" {
		t.Fatalf("desktop ids: %v", ws)
	}
	if _, err := call(t, d, "apps.focus", `{"appId":"code"}`); err != nil || !reflect.DeepEqual(win.activated, []string{"w1"}) {
		t.Fatalf("focus by desktop id: %v %v", win.activated, err)
	}
	m, err = call(t, d, "apps.close", `{"appId":"firefox-esr"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(win.closed, []string{"w2", "w3"}) {
		t.Fatalf("closed %v", win.closed)
	}
	if !reflect.DeepEqual(m["undo"], map[string]any{"tool": "apps.open", "input": map[string]any{"id": "firefox-esr"}}) {
		t.Fatalf("undo %v", m["undo"])
	}
	desc, _ := describe(t, d, "apps.close", `{"windowId":"w1"}`)
	if desc.Title != "Close site — Visual Studio Code" || !strings.Contains(desc.Detail, "Unsaved work") {
		t.Fatalf("card %+v", desc)
	}
	for args, want := range map[string]mcp.Code{`{}`: mcp.CodeInvalid, `{"windowId":"w1","appId":"code"}`: mcp.CodeInvalid, `{"appId":"gimp"}`: mcp.CodeNotFound} {
		if _, err := call(t, d, "apps.focus", args); codeOf(err) != want {
			t.Errorf("%s: %v", args, err)
		}
	}
	noWl, _ := deps(t, nil, nil)
	noWl.Windows = func() (Windows, error) { return nil, errors.New("no Wayland session found") }
	if _, err := call(t, noWl, "apps.windows", `{}`); codeOf(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "Rafiq desktop session") {
		t.Fatalf("no compositor: %v", err)
	}
}

func TestOpenPath(t *testing.T) {
	prefix := []string{"--user", "--quiet", "--collect", "--unit=app-jarvis-xdg-open-abcd1234", "-p", "ExitType=cgroup", "--setenv=WAYLAND_DISPLAY=wayland-0", "--setenv=XDG_SESSION_TYPE=wayland", "--", "/usr/bin/xdg-open"}
	run := &execx.Fake{}
	d, home := deps(t, run, nil)
	real, _ := filepath.EvalSymlinks(filepath.Join(home, "Projects", "site", "index.html"))
	run.On(execx.OK(""), "systemd-run", append(prefix, real)...)
	run.On(execx.OK(""), "systemd-run", append(prefix, "https://example.org/a?b=c")...)
	m, err := call(t, d, "apps.open_path", `{"target":"~/Projects/site/index.html"}`)
	if err != nil || m["kind"] != "file" || m["target"] != "~/Projects/site/index.html" {
		t.Fatalf("file: %v %v", m, err)
	}
	m, err = call(t, d, "apps.open_url", `{"target":"https://example.org/a?b=c"}`)
	if err != nil || m["kind"] != "url" {
		t.Fatalf("url: %v %v", m, err)
	}
	desc, _ := describe(t, d, "apps.open_url", `{"target":"https://example.org/a?b=c"}`)
	if desc.Source != mcp.SourceNetwork || desc.Title != "Open https://example.org/a?b=c" {
		t.Fatalf("url card %+v", desc)
	}
	for _, bad := range []string{"file:///etc/passwd", "javascript://x", "https://", "https://a b", "ftp://x.org", "~/.ssh/id_rsa", "/etc/passwd", "https://example.org/‮"} {
		if _, err := call(t, d, "apps.open_path", `{"target":"`+bad+`"}`); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func TestSetDefault(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("chromium.desktop\n"), "xdg-mime", "query", "default", "x-scheme-handler/https").
		On(execx.OK(""), "xdg-mime", "default", "firefox-esr.desktop", "x-scheme-handler/https").
		On(execx.OK(""), "xdg-mime", "query", "default", "text/html").
		On(execx.OK(""), "xdg-mime", "default", "firefox-esr.desktop", "text/html")
	d, _ := deps(t, run, nil)
	m, err := call(t, d, "apps.set_default", `{"mimeType":"x-scheme-handler/https","appId":"firefox-esr"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"mimeType": "x-scheme-handler/https", "previous": "chromium", "current": "firefox-esr",
		"undo": map[string]any{"tool": "apps.set_default", "input": map[string]any{"mimeType": "x-scheme-handler/https", "appId": "chromium"}}}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("got %v", m)
	}
	m, _ = call(t, d, "apps.set_default", `{"mimeType":"text/html","appId":"firefox-esr"}`)
	if m["previous"] != nil || m["undo"] != nil {
		t.Fatalf("no previous default, no undo: %v", m)
	}
	for args, want := range map[string]mcp.Code{
		`{"mimeType":"application/pdf","appId":"firefox-esr"}`:   mcp.CodeInvalid,
		`{"mimeType":"text/html; rm -rf","appId":"firefox-esr"}`: mcp.CodeInvalid,
		`{"mimeType":"text/html","appId":"nope"}`:                mcp.CodeNotFound,
	} {
		if _, err := call(t, d, "apps.set_default", args); codeOf(err) != want {
			t.Errorf("%s: %v", args, err)
		}
	}
}
func TestURLAndPathToolsStaySeparate(t *testing.T) {
	d, _ := deps(t, nil, nil)
	for _, tc := range []struct{ name, target string }{
		{"apps.open_path", "https://example.org"},
		{"apps.open_path", "mailto:user@example.org"},
		{"apps.open_url", "~/Projects/site/index.html"},
		{"apps.open_url", "file:///etc/passwd"},
		{"apps.open_url", "https://"},
		{"apps.open_url", "https://a b"},
		{"apps.open_url", "javascript://x"},
		{"apps.open_url", "ftp://x.org"},
		{"apps.open_url", "https://example.org/\u202e"},
	} {
		raw, _ := json.Marshal(map[string]string{"target": tc.target})
		if _, err := call(t, d, tc.name, string(raw)); err == nil {
			t.Errorf("%s accepted %q", tc.name, tc.target)
		}
	}
}

func TestDefaultCardDetail(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK("chromium.desktop\n"), "xdg-mime", "query", "default", "text/html")
	d, _ := deps(t, run, nil)
	desc, err := describe(t, d, "apps.set_default", `{"mimeType":"text/html","appId":"firefox-esr"}`)
	if err != nil || desc.Detail != "chromium → firefox-esr" {
		t.Fatalf("%+v %v", desc, err)
	}
}

func TestInvalidIDsAreRejectedBeforeSideEffects(t *testing.T) {
	d, _ := deps(t, nil, nil)
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"apps.open", map[string]any{"id": ""}},
		{"apps.open", map[string]any{"id": strings.Repeat("x", 256)}},
		{"apps.focus", map[string]any{"windowId": strings.Repeat("x", 33)}},
		{"apps.close", map[string]any{"appId": strings.Repeat("x", 256)}},
		{"apps.set_default", map[string]any{"mimeType": "text/html", "appId": ""}},
	} {
		raw, _ := json.Marshal(tc.args)
		if _, err := call(t, d, tc.name, string(raw)); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
}

func TestDefaultQueryFailureDoesNotChangeDefault(t *testing.T) {
	for _, exit := range []bool{false, true} {
		run := &execx.Fake{}
		if exit {
			run.On(execx.Exit(1, "query failed"), "xdg-mime", "query", "default", "text/html")
		} else {
			run.OnErr(errors.New("offline"), "xdg-mime", "query", "default", "text/html")
		}
		run.On(execx.OK(""), "xdg-mime", "default", "firefox-esr.desktop", "text/html")
		d, _ := deps(t, run, nil)
		args := `{"mimeType":"text/html","appId":"firefox-esr"}`
		if _, err := call(t, d, "apps.set_default", args); codeOf(err) != mcp.CodeFailed {
			t.Fatalf("query failure: %v", err)
		}
		if run.Ran("xdg-mime", "default", "firefox-esr.desktop", "text/html") {
			t.Fatal("changed default without reading previous value")
		}
		if _, err := describe(t, d, "apps.set_default", args); codeOf(err) != mcp.CodeFailed {
			t.Fatalf("describe failure: %v", err)
		}
	}
}

func TestOpenMailto(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(""), "systemd-run", "--user", "--quiet", "--collect", "--unit=app-jarvis-xdg-open-abcd1234", "-p", "ExitType=cgroup", "--setenv=WAYLAND_DISPLAY=wayland-0", "--setenv=XDG_SESSION_TYPE=wayland", "--", "/usr/bin/xdg-open", "mailto:user@example.org")
	d, _ := deps(t, run, nil)
	m, err := call(t, d, "apps.open_url", `{"target":"mailto:user@example.org"}`)
	if err != nil || m["undo"] != nil || m["kind"] != "url" {
		t.Fatalf("%v %v", m, err)
	}
	desc, err := describe(t, d, "apps.open_url", `{"target":"mailto:user@example.org"}`)
	if err != nil || desc.Source != mcp.SourceNetwork || !strings.Contains(desc.Detail, "email") {
		t.Fatalf("%+v %v", desc, err)
	}
}
