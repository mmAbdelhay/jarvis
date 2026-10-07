package pkgtools

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func TestInstallEachItemThroughTheHelper(t *testing.T) {
	helper := &helperapi.Fake{Reply: func(method string, args []string) (helperapi.Outcome, error) {
		switch args[0] {
		case "gimp":
			return helperapi.Outcome{OK: false, ExitCode: 100, StderrTail: "E: Failed to fetch http://deb.debian.org/x  Temporary failure resolving 'deb.debian.org'\n"}, nil
		case "com.spotify.Client":
			return helperapi.Outcome{}, &helperapi.Error{Name: helperapi.ErrNotFound, Message: "com.spotify.Client is not available from Flathub"}
		}
		return helperapi.Outcome{OK: true}, nil
	}}
	run := (&execx.Fake{}).On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", dpkgFormat, "--", "vlc")
	v, err := call(t, Deps{Run: run, Helper: helper}, "pkg.install",
		`{"items":[{"source":"apt","id":"vlc"},{"source":"apt","id":"gimp"},{"source":"flatpak","id":"com.spotify.Client"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(helper.Called(), []string{"AptInstall vlc", "AptInstall gimp", "FlatpakInstall com.spotify.Client"}) {
		t.Fatalf("helper calls = %v", helper.Called())
	}
	m := asJSON(t, v)
	inst := m["installed"].([]any)
	if len(inst) != 1 || inst[0].(map[string]any)["version"] != "3.0.21-10" {
		t.Fatalf("installed = %v", inst)
	}
	failed := m["failed"].([]any)
	if failed[0].(map[string]any)["code"] != "offline" || failed[1].(map[string]any)["code"] != "not_found" {
		t.Fatalf("failed = %v", failed)
	}
}

func TestRemoveUsesRemoveMethods(t *testing.T) {
	helper := &helperapi.Fake{}
	v, err := call(t, Deps{Run: &execx.Fake{}, Helper: helper}, "pkg.remove", `{"items":[{"source":"apt","id":"vlc"},{"source":"flatpak","id":"com.spotify.Client"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(helper.Called(), []string{"AptRemove vlc", "FlatpakRemove com.spotify.Client"}) {
		t.Fatalf("calls = %v", helper.Called())
	}
	if len(asJSON(t, v)["removed"].([]any)) != 2 {
		t.Fatalf("got %v", v)
	}
}

func TestInvalidItemsNeverReachTheHelper(t *testing.T) {
	for _, args := range []string{
		`{"items":[]}`,
		`{"items":[{"source":"apt","id":"vlc; rm -rf /"}]}`,
		`{"items":[{"source":"flatpak","id":"--from=https://evil.example/x"}]}`,
		`{"items":[{"source":"snap","id":"vlc"}]}`,
		`{"items":[{"source":"apt","id":"vlc"},{"source":"apt","id":"vlc"}]}`,
		`{"items":[{"source":"apt","id":"vlc","flags":"-y"}]}`,
	} {
		helper := &helperapi.Fake{}
		if _, err := call(t, Deps{Run: &execx.Fake{}, Helper: helper}, "pkg.install", args); code(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v, want invalid", args, err)
		}
		if len(helper.Calls) != 0 {
			t.Errorf("%s reached the helper", args)
		}
	}
}

// Review focus: Stop pressed while the first install runs. The running
// helper call is not cancelled; the remaining items are not started.
func TestStopBetweenItemsFinishesTheRunningOneAndSkipsTheRest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	helper := &helperapi.Fake{Reply: func(method string, args []string) (helperapi.Outcome, error) {
		cancel() // the user presses Stop while vlc is installing
		return helperapi.Outcome{OK: true}, nil
	}}
	run := (&execx.Fake{}).On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", dpkgFormat, "--", "vlc")
	var install mcp.Tool
	for _, tool := range Tools(Deps{Run: run, Helper: helper}) {
		if tool.Name == "pkg.install" {
			install = tool
		}
	}
	v, err := install.Call(ctx, json.RawMessage(`{"items":[{"source":"apt","id":"vlc"},{"source":"apt","id":"gimp"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	if len(helper.Calls) != 1 || len(m["installed"].([]any)) != 1 {
		t.Fatalf("calls=%v result=%v", helper.Called(), m)
	}
	f := m["failed"].([]any)[0].(map[string]any)
	if f["id"] != "gimp" || !strings.Contains(f["message"].(string), "stopped") {
		t.Fatalf("failed = %v", f)
	}
}

func TestDescribeInstall(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Package: vlc\nVersion: 3.0.21-10\nSize: 45200000\n"), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.Exit(1, ""), "dpkg-query", "-W", dpkgFormat, "--", "vlc").
		On(execx.OK("\nSpotify - Online music streaming service\n\n  ID: com.spotify.Client\n  Version: 1.2.47\n  Download: 120.3 MB\n"), "flatpak", "remote-info", "--system", "flathub", "com.spotify.Client").
		On(execx.Exit(1, ""), "flatpak", "info", "com.spotify.Client")
	helper := &helperapi.Fake{}
	d := Deps{Run: run, Helper: helper}
	var describe func(context.Context, json.RawMessage) (mcp.Description, error)
	for _, tool := range Tools(d) {
		if tool.Name == "pkg.install" {
			describe = tool.Describe
		}
	}
	one, err := describe(context.Background(), json.RawMessage(`{"items":[{"source":"apt","id":"vlc"}]}`))
	if err != nil || one.Title != "Install vlc" || one.Detail != "vlc 3.0.21-10 from Debian, 45 MB download" || one.Source != mcp.SourceDebian {
		t.Fatalf("one = %+v, %v", one, err)
	}
	two, _ := describe(context.Background(), json.RawMessage(`{"items":[{"source":"apt","id":"vlc"},{"source":"flatpak","id":"com.spotify.Client"}]}`))
	if two.Title != "Install 2 apps: vlc, Spotify" || !strings.Contains(two.Detail, "com.spotify.Client 1.2.47 from Flathub, 120 MB download") {
		t.Fatalf("two = %+v", two)
	}
	if len(helper.Calls) != 0 {
		t.Fatal("describe must not call the helper")
	}
}

func TestHumanBytes(t *testing.T) {
	for n, want := range map[int64]string{0: "0 bytes", 999: "999 bytes", 45_200_000: "45 MB", 3_200_000_000: "3.2 GB"} {
		if got := HumanBytes(n); got != want {
			t.Errorf("HumanBytes(%d) = %q, want %q", n, got, want)
		}
	}
}

// contracts §6.1: jarvisd describes each element of a batch tool on its own,
// as {items:[element]}, so every card item carries its own source.
func TestDescribeEachBatchElementOnItsOwn(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Package: vlc\nVersion: 3.0.21-10\nSize: 45200000\n"), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", dpkgFormat, "--", "vlc").
		On(execx.OK("\nSpotify - Online music streaming service\n\n  ID: com.spotify.Client\n  Version: 1.2.47\n  Download: 120.3 MB\n"), "flatpak", "remote-info", "--system", "flathub", "com.spotify.Client").
		On(execx.Exit(1, ""), "flatpak", "info", "com.spotify.Client")
	tools := map[string]mcp.Tool{}
	for _, tl := range Tools(Deps{Run: run, Helper: &helperapi.Fake{}}) {
		tools[tl.Name] = tl
	}
	if tools["pkg.install"].Batch != "items" || tools["pkg.remove"].Batch != "items" {
		t.Fatal("pkg.install and pkg.remove must declare batch \"items\"")
	}
	cases := []struct {
		tool, element, title string
		source               mcp.Source
	}{
		{"pkg.install", `{"source":"apt","id":"vlc"}`, "Install vlc", mcp.SourceDebian},
		{"pkg.install", `{"source":"flatpak","id":"com.spotify.Client"}`, "Install Spotify", mcp.SourceFlathub},
		{"pkg.remove", `{"source":"apt","id":"vlc"}`, "Remove vlc", mcp.SourceDebian},
	}
	for _, c := range cases {
		d, err := tools[c.tool].Describe(context.Background(), json.RawMessage(`{"items":[`+c.element+`]}`))
		if err != nil || d.Title != c.title || d.Source != c.source || strings.Contains(d.Detail, "\n") {
			t.Errorf("%s %s: %+v, %v", c.tool, c.element, d, err)
		}
	}
}
