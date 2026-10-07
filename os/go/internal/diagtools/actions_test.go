package diagtools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
)

func TestRestartAllowlistedUnitGoesThroughTheHelper(t *testing.T) {
	helper := &helperapi.Fake{}
	run := (&execx.Fake{}).On(execx.OK("active\n"), "systemctl", "is-active", "--", "NetworkManager.service")
	v, err := call(t, Deps{Run: run, Helper: helper}, "svc.restart", `{"unit":"NetworkManager"}`)
	if err != nil {
		t.Fatal(err)
	}
	if got := helper.Called(); len(got) != 1 || got[0] != "RestartUnit NetworkManager" {
		t.Fatalf("helper calls = %v", got)
	}
	if m := asJSON(t, v); m["unit"] != "NetworkManager.service" || m["active"] != "active" {
		t.Fatalf("got %v", m)
	}
}

func TestRestartOffAllowlistExplainsAndRunsNothing(t *testing.T) {
	helper, run := &helperapi.Fake{}, &execx.Fake{}
	_, err := call(t, Deps{Run: run, Helper: helper}, "svc.restart", `{"unit":"sshd"}`)
	te := mcp.AsToolError(err)
	if te.Code != mcp.CodeNotAllowed || !strings.Contains(te.Message, "sudo systemctl restart sshd.service") {
		t.Fatalf("got %+v", te)
	}
	if len(helper.Calls) != 0 || len(run.Calls) != 0 {
		t.Fatal("something ran for an off-allowlist unit")
	}
	if _, err := call(t, Deps{Run: run, Helper: helper}, "svc.restart", `{"unit":"sshd; reboot"}`); code(err) != mcp.CodeInvalid {
		t.Fatalf("hostile unit must be invalid (and never echoed as a command): %v", err)
	}
}

func TestRestartUserUnitRunsDirectly(t *testing.T) {
	helper := &helperapi.Fake{}
	run := (&execx.Fake{}).
		On(execx.OK(""), "systemctl", "--user", "restart", "--", "pipewire.service").
		On(execx.OK("active\n"), "systemctl", "--user", "is-active", "--", "pipewire.service")
	if _, err := call(t, Deps{Run: run, Helper: helper}, "svc.restart", `{"unit":"pipewire","scope":"user"}`); err != nil {
		t.Fatal(err)
	}
	if len(helper.Calls) != 0 {
		t.Fatal("user units must not go through the root helper")
	}
}

func TestRestartHelperRefusalsKeepTheirCode(t *testing.T) {
	helper := &helperapi.Fake{Reply: func(string, []string) (helperapi.Outcome, error) {
		return helperapi.Outcome{}, &helperapi.Error{Name: helperapi.ErrDenied, Message: "not authorized"}
	}}
	if _, err := call(t, Deps{Run: &execx.Fake{}, Helper: helper}, "svc.restart", `{"unit":"cups"}`); code(err) != mcp.CodeDenied {
		t.Fatalf("got %v", err)
	}
}

func TestConnectionUp(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Connection successfully activated\n"), "nmcli", "-w", "30", "connection", "up", "id", "Wired connection 1").
		On(execx.OK("activated\n"), "nmcli", "-t", "-g", "GENERAL.STATE", "connection", "show", "id", "Wired connection 1").
		On(execx.Exit(10, "Error: unknown connection 'Nope'."), "nmcli", "-w", "30", "connection", "up", "id", "Nope")
	v, err := call(t, Deps{Run: run}, "net.connection_up", `{"id":"Wired connection 1"}`)
	if err != nil || asJSON(t, v)["state"] != "activated" {
		t.Fatalf("got %v, %v", v, err)
	}
	if _, err := call(t, Deps{Run: run}, "net.connection_up", `{"id":"Nope"}`); code(err) != mcp.CodeNotFound {
		t.Fatalf("unknown connection: %v", err)
	}
	if _, err := call(t, Deps{Run: run}, "net.connection_up", `{"id":"--help"}`); code(err) != mcp.CodeInvalid {
		t.Fatalf("option-looking id: %v", err)
	}
}

func TestWifiConnectPassesPasswordOnStdinOnly(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(""), "nmcli", "--ask", "-w", "45", "device", "wifi", "connect", "Home")
	if _, err := call(t, Deps{Run: run}, "net.wifi_connect", `{"ssid":"Home","password":"correcthorse"}`); err != nil {
		t.Fatal(err)
	}
	c := run.Calls[0]
	if string(c.Stdin) != "correcthorse\n" || strings.Contains(strings.Join(c.Args, " "), "correcthorse") {
		t.Fatalf("password placement: args=%q stdin=%q", c.Args, c.Stdin)
	}
}

// Review focus: the Wi-Fi password never leaves jarvis-diag in a result or
// an error, even when nmcli fails and is chatty about it.
func TestWifiPasswordNeverAppearsInServerOutput(t *testing.T) {
	const pw = "s3cret-Passphrase"
	run := (&execx.Fake{}).On(execx.Exit(4, "Password: Error: Connection activation failed: Secrets were required, but not provided ("+pw+")\n"),
		"nmcli", "--ask", "-w", "45", "device", "wifi", "connect", "Cafe")
	srv := &mcp.Server{Name: "jarvis-diag", Tools: Tools(Deps{Run: run}), Redact: redact.String}
	out := serve(t, srv,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"net.wifi_connect","arguments":{"ssid":"Cafe","password":"`+pw+`"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"net.wifi_connect","arguments":{"ssid":"Cafe","password":"short"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"net.wifi_connect","input":{"ssid":"Cafe","password":"`+pw+`"}}}}`,
	)
	if strings.Contains(out, pw) || strings.Contains(out, `"short"`) {
		t.Fatalf("password leaked: %s", out)
	}
	if !strings.Contains(out, "wrong password") {
		t.Fatalf("activation failure not explained: %s", out)
	}
}

func TestWifiConnectMetaDeclaresPasswordSecret(t *testing.T) {
	tl := tool(t, Deps{}, "net.wifi_connect")
	if tl.Risk != mcp.RiskConfirm || len(tl.Secrets) != 1 || tl.Secrets[0] != "password" {
		t.Fatalf("meta = %v %v", tl.Risk, tl.Secrets)
	}
}

func TestRadioOn(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(""), "nmcli", "radio", "wifi", "on").
		On(execx.OK(`{"rfkilldevices":[{"type":"wlan","soft":"unblocked","hard":"unblocked"}]}`), "rfkill", "--json", "--output", "TYPE,SOFT,HARD")
	v, err := call(t, Deps{Run: run}, "net.radio_on", `{}`)
	if err != nil || asJSON(t, v)["wifiSoftBlocked"] != false {
		t.Fatalf("got %v, %v", v, err)
	}
}

func TestDescriptions(t *testing.T) {
	cases := []struct {
		tool, input, title string
		source             mcp.Source
	}{
		{"svc.restart", `{"unit":"NetworkManager"}`, "Restart NetworkManager", mcp.SourceSystem},
		{"svc.restart", `{"unit":"pipewire.service","scope":"user"}`, "Restart your pipewire service", mcp.SourceSystem},
		{"net.connection_up", `{"id":"Home"}`, "Connect to Home", mcp.SourceNetwork},
		{"net.wifi_connect", `{"ssid":"Cafe"}`, `Connect to Wi-Fi "Cafe"`, mcp.SourceNetwork},
		{"net.radio_on", `{}`, "Turn Wi-Fi on", mcp.SourceNetwork},
	}
	for _, c := range cases {
		d, err := tool(t, Deps{}, c.tool).Describe(context.Background(), json.RawMessage(c.input))
		if err != nil || d.Title != c.title || d.Source != c.source || d.Detail == "" {
			t.Errorf("%s: %+v, %v", c.tool, d, err)
		}
	}
	d, _ := tool(t, Deps{}, "svc.restart").Describe(context.Background(), json.RawMessage(`{"unit":"NetworkManager"}`))
	if d.Detail != "The network will drop for a few seconds." {
		t.Errorf("NM detail = %q", d.Detail)
	}
}
