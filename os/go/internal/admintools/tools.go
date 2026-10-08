// Package admintools implements the users and disks tools of Rafiq M3
// contracts §1, served by jarvis-settings: users.add, users.remove and
// disks.format_removable (risk password, through jarvis-helper's admin
// methods) and disks.mount / disks.unmount (confirm, through udisks2).
package admintools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// Deps are the tools' side effects.
type Deps struct {
	Run    execx.Runner
	Helper helperapi.Admin
}

// Undo is the undo object (contracts §1).
type Undo struct {
	Tool  string `json:"tool"`
	Input any    `json:"input"`
}

// Tools returns the users and disks tools.
func Tools(d Deps) []mcp.Tool {
	return []mcp.Tool{
		{
			Name:        "users.add",
			Description: "Create a standard user account (lowercase login name, optional full name). Needs an administrator password and a password for the new account, both entered by the user on the card, never by you.",
			InputSchema: `{"type":"object","properties":{"username":{"type":"string","minLength":1,"maxLength":32},"fullName":{"type":"string","maxLength":64},"adminPassword":{"type":"string"},"newPassword":{"type":"string"}},"required":["username"],"additionalProperties":false}`,
			Risk:        mcp.RiskPassword, Secrets: []string{"adminPassword", "newPassword"}, Call: d.addUser, Describe: d.describeAddUser,
		},
		{
			Name:        "users.remove",
			Description: "Delete a user account (never the one in use or the last administrator); keepHome keeps their files. Needs an administrator password.",
			InputSchema: `{"type":"object","properties":{"username":{"type":"string","minLength":1,"maxLength":32},"keepHome":{"type":"boolean","default":false},"adminPassword":{"type":"string"}},"required":["username"],"additionalProperties":false}`,
			Risk:        mcp.RiskPassword, Secrets: []string{"adminPassword"}, Call: d.removeUser, Describe: d.describeRemoveUser,
		},
		{
			Name:        "disks.format_removable",
			Description: "Erase a removable USB or SD drive (whole drive like /dev/sdb) and format it as exfat (all computers), vfat (old devices) or ext4 (Linux only). It must be unmounted. Needs an administrator password.",
			InputSchema: `{"type":"object","properties":{"device":{"type":"string","minLength":8,"maxLength":16},"fs":{"type":"string","enum":["exfat","vfat","ext4"]},"label":{"type":"string","maxLength":16},"adminPassword":{"type":"string"}},"required":["device","fs"],"additionalProperties":false}`,
			Risk:        mcp.RiskPassword, Secrets: []string{"adminPassword"}, Call: d.format, Describe: d.describeFormat,
		},
		{
			Name:        "disks.mount",
			Description: "Open (mount) a removable drive's partition, e.g. /dev/sdb1; returns where its files are.",
			InputSchema: deviceSchema,
			Risk:        mcp.RiskConfirm, Call: d.mount, Describe: d.describeMount,
		},
		{
			Name:        "disks.unmount",
			Description: "Safely remove (unmount) a removable drive's partition, e.g. /dev/sdb1.",
			InputSchema: deviceSchema,
			Risk:        mcp.RiskConfirm, Call: d.unmount, Describe: d.describeUnmount,
		},
	}
}

const deviceSchema = `{"type":"object","properties":{"device":{"type":"string","minLength":8,"maxLength":20}},"required":["device"],"additionalProperties":false}`

// helperResult turns a helper reply into a tool result or error.
func helperResult(out helperapi.Outcome, err error, ok map[string]any) (any, error) {
	var he *helperapi.Error
	if errors.As(err, &he) {
		return nil, mcp.Errorf(mcp.Code(he.Code()), "%s", he.Error())
	}
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "%v", err)
	}
	if !out.OK {
		return nil, mcp.Errorf(mcp.CodeFailed, "exit %d: %s", out.ExitCode, strings.TrimSpace(out.StderrTail))
	}
	ok["undo"] = nil
	return ok, nil
}

type userIn struct {
	Username, FullName, AdminPassword, NewPassword string
	KeepHome                                       bool
}

// decodeUser parses users.add or users.remove input. Describe never sees
// the secret fields (jarvisd adds them to the call only), so they are
// checked only when needsSecrets is set.
func decodeUser(raw json.RawMessage, remove, needsSecrets bool) (userIn, error) {
	var a struct {
		Username      string `json:"username"`
		FullName      string `json:"fullName"`
		KeepHome      bool   `json:"keepHome"`
		AdminPassword string `json:"adminPassword"`
		NewPassword   string `json:"newPassword"`
	}
	if err := mcp.DecodeArgs(raw, &a); err != nil {
		return userIn{}, err
	}
	in := userIn{Username: a.Username, FullName: a.FullName, KeepHome: a.KeepHome, AdminPassword: a.AdminPassword, NewPassword: a.NewPassword}
	if remove && (a.FullName != "" || a.NewPassword != "") {
		return in, mcp.Errorf(mcp.CodeInvalid, "bad arguments: users.remove takes username and keepHome")
	}
	if !remove && a.KeepHome {
		return in, mcp.Errorf(mcp.CodeInvalid, "bad arguments: users.add does not take keepHome")
	}
	if err := validate.Username(in.Username); err != nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	if err := validate.FullName(in.FullName); err != nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	if needsSecrets {
		if err := checkPassword("adminPassword", in.AdminPassword); err != nil {
			return in, err
		}
		if !remove {
			if err := checkPassword("newPassword", in.NewPassword); err != nil {
				return in, err
			}
		}
	}
	return in, nil
}

// checkPassword validates a secret field without ever echoing its value.
func checkPassword(field, v string) error {
	if err := validate.Password(v); err != nil {
		return mcp.Errorf(mcp.CodeInvalid, "%s: %v", field, err)
	}
	return nil
}

func (d Deps) addUser(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeUser(raw, false, true)
	if err != nil {
		return nil, err
	}
	out, err := d.Helper.AddUser(context.WithoutCancel(ctx), in.AdminPassword, in.Username, in.FullName, in.NewPassword)
	return helperResult(out, err, map[string]any{"username": in.Username})
}

func (d Deps) describeAddUser(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	in, err := decodeUser(raw, false, false)
	if err != nil {
		return mcp.Description{}, err
	}
	title := fmt.Sprintf(text.AddTitle, in.Username)
	if in.FullName != "" {
		title = fmt.Sprintf(text.AddTitleFull, in.Username, in.FullName)
	}
	return mcp.Description{Title: title, Detail: text.AddDetail + text.Password, Source: mcp.SourceSystem}, nil
}

func (d Deps) removeUser(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeUser(raw, true, true)
	if err != nil {
		return nil, err
	}
	out, err := d.Helper.RemoveUser(context.WithoutCancel(ctx), in.AdminPassword, in.Username, in.KeepHome)
	return helperResult(out, err, map[string]any{"username": in.Username, "keptHome": in.KeepHome})
}

func (d Deps) describeRemoveUser(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	in, err := decodeUser(raw, true, false)
	if err != nil {
		return mcp.Description{}, err
	}
	detail := text.RemoveDelete
	if in.KeepHome {
		detail = text.RemoveKeep
	}
	return mcp.Description{Title: fmt.Sprintf(text.RemoveTitle, in.Username), Detail: detail + text.Password, Source: mcp.SourceSystem}, nil
}

type formatIn struct {
	Device        string `json:"device"`
	FS            string `json:"fs"`
	Label         string `json:"label"`
	AdminPassword string `json:"adminPassword"`
}

func decodeFormat(raw json.RawMessage, needsSecrets bool) (formatIn, error) {
	var in formatIn
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	if err := validate.WholeDisk(in.Device); err != nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	label, err := validate.FSLabel(in.FS, in.Label)
	if err != nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	in.Label = label
	if needsSecrets {
		if err := checkPassword("adminPassword", in.AdminPassword); err != nil {
			return in, err
		}
	}
	return in, nil
}

func (d Deps) format(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeFormat(raw, true)
	if err != nil {
		return nil, err
	}
	out, err := d.Helper.FormatRemovable(context.WithoutCancel(ctx), in.AdminPassword, in.Device, in.FS, in.Label)
	return helperResult(out, err, map[string]any{"device": in.Device, "fs": in.FS})
}

// driveName describes a drive for a card ("SanDisk Ultra, 32 GB"),
// reading lsblk as the user; "" when unknown.
func (d Deps) driveName(ctx context.Context, device string) string {
	res, err := d.Run.Run(ctx, execx.Cmd{Name: "lsblk", Args: []string{"--json", "--bytes", "--nodeps", "--output", "MODEL,SIZE", "--", device}, Timeout: 10 * time.Second})
	if err != nil || res.ExitCode != 0 {
		return ""
	}
	var out struct {
		Blockdevices []struct {
			Model *string `json:"model"`
			Size  int64   `json:"size"`
		} `json:"blockdevices"`
	}
	if json.Unmarshal(res.Stdout, &out) != nil || len(out.Blockdevices) != 1 {
		return ""
	}
	b := out.Blockdevices[0]
	name := text.UnknownDrive
	if b.Model != nil && strings.TrimSpace(*b.Model) != "" {
		name = strings.TrimSpace(*b.Model)
	}
	return fmt.Sprintf("%s, %.0f GB", name, float64(b.Size)/1e9)
}

func (d Deps) describeFormat(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	in, err := decodeFormat(raw, false)
	if err != nil {
		return mcp.Description{}, err
	}
	drive := d.driveName(ctx, in.Device)
	if drive == "" {
		drive = in.Device
	} else {
		drive = in.Device + " (" + drive + ")"
	}
	return mcp.Description{Title: fmt.Sprintf(text.FormatTitle, in.Device, in.FS), Detail: fmt.Sprintf(text.FormatDetail, drive) + text.Password, Source: mcp.SourceSystem}, nil
}

var partRe = regexp.MustCompile(`^/dev/(sd[a-z]{1,2}[0-9]{0,3}|mmcblk[0-9]{1,2}(p[0-9]{1,3})?)$`)

func decodeDevice(raw json.RawMessage) (string, error) {
	var in struct {
		Device string `json:"device"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return "", err
	}
	if !partRe.MatchString(in.Device) {
		return "", mcp.Errorf(mcp.CodeInvalid, text.BadPartition, in.Device)
	}
	return in.Device, nil
}

var mountedRe = regexp.MustCompile(`^Mounted \S+ at (.+?)\.?$`)

// udisks runs udisksctl without ever prompting (polkit decides).
func (d Deps) udisks(ctx context.Context, verb, device string) (string, error) {
	res, err := d.Run.Run(ctx, execx.Cmd{Name: "udisksctl", Args: []string{verb, "--block-device", device, "--no-user-interaction"}, Timeout: 60 * time.Second})
	if err != nil {
		return "", mcp.Errorf(mcp.CodeFailed, "udisksctl: %v", err)
	}
	if res.ExitCode != 0 {
		msg := strings.TrimSpace(string(res.Stderr))
		code := mcp.CodeFailed
		switch {
		case strings.Contains(msg, "NotAuthorized"):
			code = mcp.CodeDenied
		case strings.Contains(msg, "AlreadyMounted"), strings.Contains(msg, "NotMounted"):
			code = mcp.CodeInvalid
		case strings.Contains(msg, "Error looking up object"):
			code = mcp.CodeNotFound
		}
		return "", mcp.Errorf(code, "%s", msg)
	}
	return strings.TrimSpace(string(res.Stdout)), nil
}

func (d Deps) mount(ctx context.Context, raw json.RawMessage) (any, error) {
	dev, err := decodeDevice(raw)
	if err != nil {
		return nil, err
	}
	out, err := d.udisks(ctx, "mount", dev)
	if err != nil {
		return nil, err
	}
	where := ""
	if m := mountedRe.FindStringSubmatch(out); m != nil {
		where = m[1]
	}
	return map[string]any{"device": dev, "mountpoint": where, "undo": Undo{Tool: "disks.unmount", Input: map[string]string{"device": dev}}}, nil
}

func (d Deps) unmount(ctx context.Context, raw json.RawMessage) (any, error) {
	dev, err := decodeDevice(raw)
	if err != nil {
		return nil, err
	}
	if _, err := d.udisks(ctx, "unmount", dev); err != nil {
		return nil, err
	}
	return map[string]any{"device": dev, "undo": Undo{Tool: "disks.mount", Input: map[string]string{"device": dev}}}, nil
}

func (d Deps) describeMount(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	dev, err := decodeDevice(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	return mcp.Description{Title: fmt.Sprintf(text.MountTitle, dev), Detail: text.MountDetail, Source: mcp.SourceSystem}, nil
}

func (d Deps) describeUnmount(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	dev, err := decodeDevice(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	return mcp.Description{Title: fmt.Sprintf(text.UnmountTitle, dev), Detail: text.MountDetail, Source: mcp.SourceSystem}, nil
}
