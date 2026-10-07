package pkgtools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

const simUpgrade = `Reading package lists...
Inst jarvis-shell [0.1.0] (0.2.0 jarvis:trixie [amd64])
Inst libssl3t64 [3.5.1-1] (3.5.1-1+deb13u1 Debian:13.7/stable, Debian-Security:13/stable-security [amd64])
Conf libssl3t64 (3.5.1-1+deb13u1 Debian:13.7/stable, Debian-Security:13/stable-security [amd64])
`

var simArgs = []string{"-s", "-o", "Debug::NoLocking=true", "--with-new-pkgs", "upgrade"}

func updatesDeps(run *execx.Fake, h *helperapi.Fake) Deps {
	return Deps{Run: run, Helper: h, Now: func() time.Time { return time.Date(2026, 10, 8, 12, 0, 0, 0, time.FixedZone("x", 3600)) }}
}

func flatpakListOK(run *execx.Fake) *execx.Fake {
	return run.
		On(execx.OK("org.videolan.VLC\t3.0.22\tflathub\norg.example.Beta\t2.0\tflathub-beta\n"), "flatpak", "remote-ls", "--updates", "--system", "--app", "--columns=application,version,origin").
		On(execx.OK("org.videolan.VLC\t3.0.21\tflathub\norg.example.Beta\t1.9\tflathub-beta\n"), "flatpak", "list", "--system", "--app", "--columns=application,version,origin")
}

func TestUpdatesListSecurityFirstFlathubOnly(t *testing.T) {
	run := flatpakListOK((&execx.Fake{}).On(execx.OK(simUpgrade), "apt-get", simArgs...))
	got, err := call(t, updatesDeps(run, &helperapi.Fake{}), "updates.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	want := `{"checkedAt":"2026-10-08T11:00:00Z","items":[` +
		`{"source":"apt","id":"libssl3t64","from":"3.5.1-1","to":"3.5.1-1+deb13u1","security":true},` +
		`{"source":"apt","id":"jarvis-shell","from":"0.1.0","to":"0.2.0","security":false},` +
		`{"source":"flatpak","id":"org.videolan.VLC","from":"3.0.21","to":"3.0.22","security":false}]}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}

func TestUpdatesListIncludesKeptBackKernelMetapackage(t *testing.T) {
	const keptBack = `Reading package lists...
The following packages have been kept back:
  linux-image-amd64
0 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.
`
	const withNewPkgs = `Reading package lists...
The following NEW packages will be installed:
  linux-image-6.12.64+deb13-amd64
The following packages will be upgraded:
  linux-image-amd64
1 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.
Inst linux-image-6.12.64+deb13-amd64 (6.12.64-1 Debian-Security:13/stable-security [amd64])
Inst linux-image-amd64 [6.12.63-1] (6.12.64-1 Debian-Security:13/stable-security [amd64])
`
	run := (&execx.Fake{}).
		On(execx.OK(keptBack), "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade").
		On(execx.OK(withNewPkgs), "apt-get", simArgs...)
	got, err := call(t, updatesDeps(run, &helperapi.Fake{}), "updates.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"checkedAt":"2026-10-08T11:00:00Z","items":[` +
		`{"source":"apt","id":"linux-image-amd64","from":"6.12.63-1","to":"6.12.64-1","security":true}]}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}

func TestUpdatesListAptFailureIsFailedWithAptMessage(t *testing.T) {
	run := (&execx.Fake{}).On(execx.Exit(100, "E: The repository 'https://mmabdelhay.github.io/jarvis-apt trixie InRelease' is not signed.\n"), "apt-get", simArgs...)
	_, err := call(t, updatesDeps(run, &helperapi.Fake{}), "updates.list", `{}`)
	if code(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "is not signed") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdatesListWithoutFlatpakStillListsApt(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(simUpgrade), "apt-get", simArgs...) // flatpak argv unregistered: "not found"
	got, err := call(t, updatesDeps(run, &helperapi.Fake{}), "updates.list", `{}`)
	if err != nil || len(asJSON(t, got)["items"].([]any)) != 2 {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := call(t, updatesDeps(run, &helperapi.Fake{}), "updates.list", `{"x":1}`); code(err) != mcp.CodeInvalid {
		t.Fatalf("unknown argument: %v", err)
	}
}

func TestUpdatesApplyOneAptCallVersionsReadBack(t *testing.T) {
	n := 0
	h := &helperapi.Fake{}
	d := updatesDeps(nil, h)
	// dpkg-query answers "before" on the first call and "after" on the second.
	d.Run = runFunc(func(c execx.Cmd) (execx.Result, error) {
		if c.Name == "dpkg-query" {
			n++
			if n == 1 {
				return execx.OK("jarvis-shell\t0.1.0\tinstalled\nlibssl3t64\t3.5.1-1\tinstalled\n"), nil
			}
			return execx.OK("jarvis-shell\t0.2.0\tinstalled\nlibssl3t64\t3.5.1-1\tinstalled\n"), nil
		}
		return execx.Result{ExitCode: -1}, fmt.Errorf("unexpected %s", c.Name)
	})
	got, err := call(t, d, "updates.apply", `{"items":[{"source":"apt","id":"jarvis-shell"},{"source":"apt","id":"libssl3t64"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if c := h.Called(); len(c) != 1 || c[0] != "AptUpgrade jarvis-shell libssl3t64" {
		t.Fatalf("helper calls = %v", c)
	}
	b, _ := json.Marshal(got)
	want := `{"failed":[{"source":"apt","id":"libssl3t64","code":"failed","message":"not upgraded: no newer version was available"}],"upgraded":[{"source":"apt","id":"jarvis-shell","version":"0.2.0"}]}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}

type runFunc func(execx.Cmd) (execx.Result, error)

func (f runFunc) Run(_ context.Context, c execx.Cmd) (execx.Result, error) { return f(c) }

func TestUpdatesApplyFlatpakByCommitAndOffline(t *testing.T) {
	commits := 0
	d := updatesDeps(nil, &helperapi.Fake{Reply: func(m string, _ []string) (helperapi.Outcome, error) {
		return helperapi.Outcome{OK: false, ExitCode: 1, StderrTail: "error: Could not resolve host: dl.flathub.org"}, nil
	}})
	d.Run = runFunc(func(c execx.Cmd) (execx.Result, error) {
		if c.Name == "flatpak" && strings.Join(c.Args, " ") == "info --system --show-commit org.videolan.VLC" {
			commits++
			return execx.OK("abc123\n"), nil // unchanged before and after
		}
		return execx.Result{ExitCode: -1}, fmt.Errorf("unexpected %v", c)
	})
	got, err := call(t, d, "updates.apply", `{"items":[{"source":"flatpak","id":"org.videolan.VLC"}]}`)
	if err != nil || commits != 2 {
		t.Fatalf("err=%v commits=%d", err, commits)
	}
	f := asJSON(t, got)["failed"].([]any)[0].(map[string]any)
	if f["code"] != "offline" {
		t.Fatalf("failed = %v", f)
	}
}

func TestUpdatesApplyValidation(t *testing.T) {
	d := updatesDeps(&execx.Fake{}, &helperapi.Fake{})
	var many []string
	for i := 0; i < 201; i++ {
		many = append(many, fmt.Sprintf(`{"source":"apt","id":"p%d"}`, i))
	}
	for _, in := range []string{
		`{"items":[]}`,
		`{"items":[` + strings.Join(many, ",") + `]}`,
		`{"items":[{"source":"apt","id":"-o"}]}`,
		`{"items":[{"source":"snap","id":"x"}]}`,
		`{"items":[{"source":"apt","id":"vlc"},{"source":"apt","id":"vlc"}]}`,
	} {
		if _, err := call(t, d, "updates.apply", in); code(err) != mcp.CodeInvalid {
			t.Errorf("%.60s: err = %v", in, err)
		}
	}
	if len(d.Helper.(*helperapi.Fake).Calls) != 0 {
		t.Fatal("helper was called for invalid input")
	}
	ok := `{"items":[` + strings.Join(many[:200], ",") + `]}`
	if _, err := decodeUpdateItems(json.RawMessage(ok)); err != nil {
		t.Fatalf("200 items must be accepted: %v", err)
	}
}

func TestUpdatesApplyStoppedBeforeStartRunsNothing(t *testing.T) {
	h := &helperapi.Fake{}
	d := updatesDeps(&execx.Fake{}, h)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var tool mcp.Tool
	for _, tl := range Tools(d) {
		if tl.Name == "updates.apply" {
			tool = tl
		}
	}
	got, err := tool.Call(ctx, json.RawMessage(`{"items":[{"source":"apt","id":"vlc"}]}`))
	if err != nil || len(h.Calls) != 0 || len(asJSON(t, got)["failed"].([]any)) != 1 {
		t.Fatalf("got %v, %v, calls %v", got, err, h.Calls)
	}
}

func describe(t *testing.T, tools []mcp.Tool, input string) mcp.Description {
	t.Helper()
	for _, tl := range tools {
		if tl.Name == "updates.apply" {
			desc, err := tl.Describe(context.Background(), json.RawMessage(input))
			if err != nil {
				t.Fatal(err)
			}
			return desc
		}
	}
	t.Fatal("no updates.apply")
	return mcp.Description{}
}

func TestDescribeUpdateUsesTheCachedList(t *testing.T) {
	run := flatpakListOK((&execx.Fake{}).On(execx.OK(simUpgrade), "apt-get", simArgs...))
	tools := Tools(updatesDeps(run, &helperapi.Fake{}))
	for _, tl := range tools {
		if tl.Name == "updates.list" {
			if _, err := tl.Call(context.Background(), json.RawMessage(`{}`)); err != nil {
				t.Fatal(err)
			}
		}
	}
	d := describe(t, tools, `{"items":[{"source":"apt","id":"libssl3t64"}]}`)
	if d.Title != "Upgrade libssl3t64 3.5.1-1 → 3.5.1-1+deb13u1 (Debian, security)" || d.Source != mcp.SourceDebian ||
		d.Detail != "libssl3t64 3.5.1-1 → 3.5.1-1+deb13u1 from Debian (security update). Nothing is removed." {
		t.Fatalf("got %+v", d)
	}
	d = describe(t, tools, `{"items":[{"source":"apt","id":"jarvis-shell"}]}`)
	if d.Title != "Upgrade jarvis-shell 0.1.0 → 0.2.0 (Debian)" {
		t.Fatalf("got %+v", d)
	}
	d = describe(t, tools, `{"items":[{"source":"flatpak","id":"org.videolan.VLC"}]}`)
	if d.Title != "Upgrade org.videolan.VLC 3.0.21 → 3.0.22 (Flathub)" || d.Source != mcp.SourceFlathub {
		t.Fatalf("got %+v", d)
	}
}

func TestDescribeUpdateFallsBackToAptCachePolicy(t *testing.T) {
	policy := "linux-libc-dev:\n  Installed: 6.12.63-1\n  Candidate: 6.12.111-1\n  Version table:\n     6.12.111-1 500\n        500 http://deb.debian.org/debian-security trixie-security/main amd64 Packages\n *** 6.12.63-1 100\n        100 /var/lib/dpkg/status\n"
	run := (&execx.Fake{}).
		On(execx.OK(policy), "apt-cache", "policy", "--", "linux-libc-dev").
		On(execx.OK("VLC - media player\n  ID: org.videolan.VLC\n  Ref: app/org.videolan.VLC/x86_64/stable\n  Version: 3.0.21\n"), "flatpak", "info", "--system", "org.videolan.VLC").
		On(execx.OK("VLC - media player\n  ID: org.videolan.VLC\n  Ref: app/org.videolan.VLC/x86_64/stable\n  Version: 3.0.22\n"), "flatpak", "remote-info", "--system", "flathub", "org.videolan.VLC")
	tools := Tools(updatesDeps(run, &helperapi.Fake{}))
	if d := describe(t, tools, `{"items":[{"source":"apt","id":"linux-libc-dev"}]}`); d.Title != "Upgrade linux-libc-dev 6.12.63-1 → 6.12.111-1 (Debian, security)" {
		t.Fatalf("got %+v", d)
	}
	if d := describe(t, tools, `{"items":[{"source":"flatpak","id":"org.videolan.VLC"}]}`); d.Title != "Upgrade org.videolan.VLC 3.0.21 → 3.0.22 (Flathub)" {
		t.Fatalf("got %+v", d)
	}
	// Lookup failed entirely: still a readable card, never an error.
	if d := describe(t, Tools(updatesDeps(&execx.Fake{}, &helperapi.Fake{})), `{"items":[{"source":"apt","id":"curl"}]}`); d.Title != "Upgrade curl (Debian)" {
		t.Fatalf("got %+v", d)
	}
}
