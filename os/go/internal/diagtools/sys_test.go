package diagtools

import (
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
)

func procFS() fstest.MapFS {
	return fstest.MapFS{
		"proc/uptime":  {Data: []byte("3605.27 7012.40\n")},
		"proc/loadavg": {Data: []byte("0.42 0.30 0.25 1/312 4242\n")},
		"proc/meminfo": {Data: []byte("MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n")},
	}
}

func TestHealth(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Mounted on 1B-blocks Used\n/ 4123459584 987654144\n"), "df", parse.DfArgs...).
		On(execx.OK("crashy.service loaded failed failed Crashy\n"), "systemctl", "list-units", "--failed", "--plain", "--no-legend", "--no-pager").
		On(execx.OK("Id=crashy.service\nResult=exit-code\nStateChangeTimestamp=Tue 2026-10-07 09:12:44 UTC\n"), "systemctl", "show", "-p", "Id,Result,StateChangeTimestamp", "--", "crashy.service").
		On(execx.Exit(1, "Failed to connect to bus: No medium found"), "systemctl", "--user", "list-units", "--failed", "--plain", "--no-legend", "--no-pager").
		On(execx.OK("{\"PRIORITY\":\"3\"}\n{\"PRIORITY\":\"2\"}\n"), "journalctl", "-b", "-p", "3", "-q", "--no-pager", "-o", "json", "--output-fields=PRIORITY", "-n", "10000")
	v, err := call(t, Deps{Run: run, FS: procFS()}, "sys.health", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	h := v.(Health)
	if h.UptimeSec != 3605 || h.Load1 != 0.42 || h.MemTotalBytes != 4000000*1024 || h.MemUsedBytes != 1000000*1024 || h.SwapUsedBytes != 600*1024 {
		t.Errorf("proc numbers = %+v", h)
	}
	if len(h.Disks) != 1 || h.FailedUnits != 1 || h.BootErrors != 2 {
		t.Errorf("disks=%v failed=%d bootErrors=%d", h.Disks, h.FailedUnits, h.BootErrors)
	}
}

func logsArgs(prio, n int, extra ...string) []string {
	since := now.Add(-60 * time.Minute).Unix()
	return append([]string{"-q", "--no-pager", "-o", "json", "--since=@" + strconv.FormatInt(since, 10), "-p", strconv.Itoa(prio), "-n", strconv.Itoa(n)}, extra...)
}

func TestLogsQueryDefaultsAndUnit(t *testing.T) {
	journal := fixture(t, "journal.json")
	run := (&execx.Fake{}).On(execx.Result{Stdout: journal}, "journalctl", logsArgs(4, 101, "-u", "NetworkManager.service")...)
	v, err := call(t, Deps{Run: run}, "logs.query", `{"unit":"NetworkManager.service"}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	lines := m["lines"].([]any)
	if len(lines) != 6 || m["truncated"] != false {
		t.Fatalf("lines=%d truncated=%v", len(lines), m["truncated"])
	}
	first := lines[0].(map[string]any)
	if first["ts"] != "2025-10-07T10:00:00Z" || first["unit"] != "NetworkManager.service" || first["priority"] != 3.0 {
		t.Errorf("first = %v", first)
	}
}

func TestLogsQueryGrepAndLimit(t *testing.T) {
	journal := fixture(t, "journal.json")
	run := (&execx.Fake{}).On(execx.Result{Stdout: journal}, "journalctl", logsArgs(4, grepWindow)...)
	v, err := call(t, Deps{Run: run}, "logs.query", `{"grep":"WLP2S0","limit":1}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	lines := m["lines"].([]any)
	if len(lines) != 1 || m["truncated"] != true || !strings.Contains(lines[0].(map[string]any)["message"].(string), "WRONG_KEY") {
		t.Fatalf("got %v", m)
	}
}

// Review focus: a log line holding a secret is redacted, not dropped, once
// it passes through the server the way jarvis-diag wires it.
func TestLogsQuerySecretsAreRedactedByTheServer(t *testing.T) {
	line := `{"__REALTIME_TIMESTAMP":"1759831200000000","PRIORITY":"3","_SYSTEMD_UNIT":"app.service","MESSAGE":"retry with Authorization: Bearer sk-ant-api03-AbCdEf0123456789xyz then gave up"}` + "\n"
	run := (&execx.Fake{}).On(execx.OK(line), "journalctl", logsArgs(4, 101)...)
	srv := &mcp.Server{Name: "jarvis-diag", Tools: Tools(Deps{Run: run, Now: func() time.Time { return now }}), Redact: redact.String}
	out := serve(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"logs.query","arguments":{}}}`)
	if strings.Contains(out, "sk-ant-") || !strings.Contains(out, "retry with Authorization: [redacted:authorization]") {
		t.Fatalf("server output = %s", out)
	}
}

// The grep filter must see only what the caller may see: matching on the raw
// message would let a caller probe a redacted secret one guess at a time.
func TestLogsQueryGrepMatchesTheRedactedMessage(t *testing.T) {
	line := `{"__REALTIME_TIMESTAMP":"1759831200000000","PRIORITY":"3","_SYSTEMD_UNIT":"app.service","MESSAGE":"login password=hunter2 failed"}` + "\n"
	for _, tc := range []struct {
		grep string
		want int
	}{
		{"hunter2", 0},
		{"HUNTER", 0},
		{"password=h", 0},
		{"password=[redacted", 1},
		{"login", 1},
	} {
		run := (&execx.Fake{}).On(execx.OK(line), "journalctl", logsArgs(4, grepWindow)...)
		v, err := call(t, Deps{Run: run, Now: func() time.Time { return now }}, "logs.query", `{"grep":"`+tc.grep+`"}`)
		if err != nil {
			t.Fatal(err)
		}
		lines := asJSON(t, v)["lines"].([]any)
		if len(lines) != tc.want {
			t.Errorf("grep %q: %d lines, want %d", tc.grep, len(lines), tc.want)
		}
		for _, l := range lines {
			if msg := l.(map[string]any)["message"].(string); strings.Contains(msg, "hunter2") {
				t.Errorf("grep %q leaked %q", tc.grep, msg)
			}
		}
	}
}

func TestLogsQueryRejectsBadInput(t *testing.T) {
	for _, args := range []string{`{"priority":8}`, `{"sinceMinutes":0}`, `{"sinceMinutes":1441}`, `{"limit":201}`, `{"unit":"x; reboot"}`, `{"unit":"-k"}`, `{"grep":"` + strings.Repeat("a", 101) + `"}`} {
		if _, err := call(t, Deps{Run: &execx.Fake{}}, "logs.query", args); code(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v, want invalid", args, err)
		}
	}
}

func TestSvcStatus(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Id=crashy.service\nLoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nStateChangeTimestamp=Tue 2026-10-07 09:12:44 UTC\n"),
			"systemctl", "show", "-p", "Id,LoadState,ActiveState,SubState,Result,StateChangeTimestamp", "--", "crashy.service").
		On(execx.OK(`{"MESSAGE":"crashy.service: Main process exited, code=exited, status=1/FAILURE"}`+"\n"), "journalctl", "-q", "--no-pager", "-o", "json", "-n", "10", "-u", "crashy.service").
		On(execx.OK("Id=nope.service\nLoadState=not-found\n"), "systemctl", "--user", "show", "-p", "Id,LoadState,ActiveState,SubState,Result,StateChangeTimestamp", "--", "nope.service")
	v, err := call(t, Deps{Run: run}, "svc.status", `{"unit":"crashy"}`)
	if err != nil {
		t.Fatal(err)
	}
	st := v.(Status)
	if st.Unit != "crashy.service" || st.Active != "failed" || st.Result != "exit-code" || st.Since != "2026-10-07T09:12:44Z" || len(st.LastLines) != 1 {
		t.Fatalf("got %+v", st)
	}
	if _, err := call(t, Deps{Run: run}, "svc.status", `{"unit":"nope","scope":"user"}`); code(err) != mcp.CodeNotFound {
		t.Fatalf("missing unit: %v", err)
	}
}

func TestListFailedBothScopes(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("crashy.service loaded failed failed Crashy\n"), "systemctl", "list-units", "--failed", "--plain", "--no-legend", "--no-pager").
		On(execx.OK("Id=crashy.service\nResult=exit-code\nStateChangeTimestamp=Tue 2026-10-07 09:12:44 UTC\n"), "systemctl", "show", "-p", "Id,Result,StateChangeTimestamp", "--", "crashy.service").
		On(execx.OK("pipewire.service loaded failed failed PipeWire\n"), "systemctl", "--user", "list-units", "--failed", "--plain", "--no-legend", "--no-pager").
		On(execx.OK("Id=pipewire.service\nResult=core-dump\nStateChangeTimestamp=\n"), "systemctl", "--user", "show", "-p", "Id,Result,StateChangeTimestamp", "--", "pipewire.service")
	v, err := call(t, Deps{Run: run}, "svc.list_failed", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	units := v.(map[string]any)["units"].([]FailedUnit)
	want := []FailedUnit{{"crashy.service", "system", "exit-code", "2026-10-07T09:12:44Z"}, {"pipewire.service", "user", "core-dump", ""}}
	if len(units) != 2 || units[0] != want[0] || units[1] != want[1] {
		t.Fatalf("got %+v", units)
	}
}
