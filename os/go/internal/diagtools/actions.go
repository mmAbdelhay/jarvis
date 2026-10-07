package diagtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

func (d Deps) actionTools() []mcp.Tool {
	return []mcp.Tool{
		{
			Name: "svc.restart",
			Description: "Restart a systemd unit. System scope: only NetworkManager, wpa_supplicant, systemd-resolved, bluetooth, cups, docker; " +
				"anything else returns not_allowed with the command the user can run themselves. User scope: any of the user's own units.",
			InputSchema: unitScopeSchema, Risk: mcp.RiskConfirm, Call: d.svcRestart, Describe: d.describeRestart,
		},
		{
			Name:        "net.connection_up",
			Description: "Activate a saved NetworkManager connection by name.",
			InputSchema: `{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128}},"required":["id"],"additionalProperties":false}`,
			Risk:        mcp.RiskConfirm, Call: d.connectionUp, Describe: d.describeConnectionUp,
		},
		{
			Name:        "net.wifi_connect",
			Description: "Connect to a Wi-Fi network by SSID. Never fill in the password: the user types it on the confirm card.",
			InputSchema: `{"type":"object","properties":{"ssid":{"type":"string","minLength":1,"maxLength":32},"password":{"type":"string","minLength":8,"maxLength":64}},"required":["ssid"],"additionalProperties":false}`,
			Risk:        mcp.RiskConfirm, Secrets: []string{"password"}, Call: d.wifiConnect, Describe: d.describeWifiConnect,
		},
		{
			Name:        "net.radio_on",
			Description: "Turn the Wi-Fi radio on when it is switched off in software (wifiSoftBlocked in net.status).",
			InputSchema: mcp.EmptySchema, Risk: mcp.RiskConfirm, Call: d.radioOn, Describe: d.describeRadioOn,
		},
	}
}

type unitArgs struct {
	Unit  string `json:"unit"`
	Scope string `json:"scope"`
}

func decodeUnit(raw json.RawMessage) (unitArgs, error) {
	var in unitArgs
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	scope, err := checkScope(in.Scope)
	if err != nil {
		return in, err
	}
	in.Scope = scope
	if err := validate.UnitName(in.Unit); err != nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	return in, nil
}

func (d Deps) svcRestart(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeUnit(raw)
	if err != nil {
		return nil, err
	}
	unit := validate.ServiceUnit(in.Unit)
	if in.Scope == "user" {
		res, err := d.run(context.WithoutCancel(ctx), 90*time.Second, "systemctl", "--user", "restart", "--", unit)
		if err != nil || res.ExitCode != 0 {
			return nil, mcp.Errorf(mcp.CodeFailed, "restart failed: %s", strings.TrimSpace(string(res.Stderr)))
		}
		return map[string]any{"unit": unit, "active": d.isActive(ctx, "user", unit)}, nil
	}
	bare, err := validate.RestartableUnit(in.Unit)
	if errors.Is(err, validate.ErrNotAllowed) {
		// design §10: explain, and give the exact command; never run it.
		// in.Unit passed UnitName, so it is safe to show as a command.
		return nil, mcp.Errorf(mcp.CodeNotAllowed, "%s is not on Jarvis's restart allowlist. To restart it yourself, open a terminal (Ctrl+Alt+T) and run: sudo systemctl restart %s", in.Unit, unit)
	}
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	out, herr := d.Helper.RestartUnit(context.WithoutCancel(ctx), bare)
	if herr != nil {
		var he *helperapi.Error
		if errors.As(herr, &he) {
			return nil, &mcp.ToolError{Code: mcp.Code(he.Code()), Message: he.Error()}
		}
		return nil, mcp.Errorf(mcp.CodeFailed, "%v", herr)
	}
	if !out.OK {
		return nil, mcp.Errorf(mcp.CodeFailed, "systemctl restart exited %d: %s", out.ExitCode, strings.TrimSpace(out.StderrTail))
	}
	return map[string]any{"unit": bare + ".service", "active": d.isActive(ctx, "system", bare+".service")}, nil
}

func (d Deps) isActive(ctx context.Context, scope, unit string) string {
	res, err := d.run(ctx, queryTimeout, "systemctl", append(scopeArgs(scope), "is-active", "--", unit)...)
	if err != nil {
		return "unknown"
	}
	// is-active prints the state and exits non-zero for anything but active.
	if s := strings.TrimSpace(string(res.Stdout)); s != "" {
		return s
	}
	return "unknown"
}

func (d Deps) describeRestart(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	in, err := decodeUnit(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	bare := strings.TrimSuffix(in.Unit, ".service")
	detail := cardText.RestartEffect[bare]
	if detail == "" || in.Scope == "user" {
		detail = cardText.RestartDefault
	}
	title := fmt.Sprintf(cardText.RestartTitle, bare)
	if in.Scope == "user" {
		title = fmt.Sprintf(cardText.RestartUserTitle, bare)
	}
	return mcp.Description{Title: title, Detail: detail, Source: mcp.SourceSystem}, nil
}

func decodeConnection(raw json.RawMessage) (string, error) {
	var in struct {
		ID string `json:"id"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return "", err
	}
	if err := validate.ConnectionID(in.ID); err != nil {
		return "", mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	return in.ID, nil
}

func (d Deps) connectionUp(ctx context.Context, raw json.RawMessage) (any, error) {
	id, err := decodeConnection(raw)
	if err != nil {
		return nil, err
	}
	// "id" makes nmcli read the next argument as a name, whatever it says.
	res, err := d.run(context.WithoutCancel(ctx), 45*time.Second, "nmcli", "-w", "30", "connection", "up", "id", id)
	if err != nil || res.ExitCode != 0 {
		return nil, nmError(res.ExitCode, err)
	}
	return map[string]any{"connection": id, "state": d.connectionState(ctx, id)}, nil
}

func (d Deps) connectionState(ctx context.Context, id string) string {
	res, err := d.run(ctx, queryTimeout, "nmcli", "-t", "-g", "GENERAL.STATE", "connection", "show", "id", id)
	if s := strings.TrimSpace(string(res.Stdout)); err == nil && s != "" {
		return s
	}
	return "unknown"
}

func (d Deps) describeConnectionUp(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	id, err := decodeConnection(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	return mcp.Description{Title: fmt.Sprintf(cardText.ConnectTitle, id), Detail: fmt.Sprintf(cardText.ConnectDetail, id), Source: mcp.SourceNetwork}, nil
}

type wifiArgs struct {
	SSID     string `json:"ssid"`
	Password string `json:"password"`
}

func decodeWifi(raw json.RawMessage) (wifiArgs, error) {
	var in wifiArgs
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	if err := validate.SSID(in.SSID); err != nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	if in.Password != "" {
		if err := validate.WifiPassword(in.Password); err != nil {
			// The message never echoes the password.
			return in, mcp.Errorf(mcp.CodeInvalid, "the Wi-Fi password is not valid: it needs 8 to 63 characters")
		}
	}
	return in, nil
}

// wifiConnect joins a network. The password goes to nmcli on stdin
// (--ask), never in argv, where any local process could read it from
// /proc/<pid>/cmdline. No error path includes the password: messages come
// from nmError's fixed texts only.
func (d Deps) wifiConnect(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeWifi(raw)
	if err != nil {
		return nil, err
	}
	args := []string{"-w", "45", "device", "wifi", "connect", in.SSID}
	var stdin []byte
	if in.Password != "" {
		args = append([]string{"--ask"}, args...)
		stdin = []byte(in.Password + "\n")
	}
	res, err := d.Run.Run(context.WithoutCancel(ctx), execx.Cmd{Name: "nmcli", Args: args, Stdin: stdin, Timeout: 60 * time.Second})
	if err != nil || res.ExitCode != 0 {
		return nil, nmError(res.ExitCode, err)
	}
	return map[string]any{"ssid": in.SSID, "state": "activated"}, nil
}

func (d Deps) describeWifiConnect(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	in, err := decodeWifi(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	return mcp.Description{
		Title:  fmt.Sprintf(cardText.WifiTitle, in.SSID),
		Detail: cardText.WifiDetail,
		Source: mcp.SourceNetwork,
	}, nil
}

func (d Deps) radioOn(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	res, err := d.run(context.WithoutCancel(ctx), queryTimeout, "nmcli", "radio", "wifi", "on")
	if err != nil || res.ExitCode != 0 {
		return nil, nmError(res.ExitCode, err)
	}
	if rf, err := d.run(ctx, queryTimeout, "rfkill", "--json", "--output", "TYPE,SOFT,HARD"); err == nil {
		if r, err := parse.Rfkill(rf.Stdout); err == nil && r.WifiSoftBlocked {
			return nil, mcp.Errorf(mcp.CodeFailed, "Wi-Fi is still switched off in software after turning it on")
		}
	}
	return map[string]any{"wifiSoftBlocked": false}, nil
}

func (d Deps) describeRadioOn(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return mcp.Description{}, err
	}
	return mcp.Description{Title: cardText.RadioTitle, Detail: cardText.RadioDetail, Source: mcp.SourceNetwork}, nil
}
