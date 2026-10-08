package admintools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

const emptySchema = `{"type":"object","properties":{},"additionalProperties":false}`

func listTools(d Deps) []mcp.Tool {
	return []mcp.Tool{
		{
			Name:        "users.list",
			Description: "List the human user accounts (login name and full name), so you know the exact username for users.remove. System accounts are never listed.",
			InputSchema: emptySchema,
			Risk:        mcp.RiskSafe, Call: d.listUsers,
		},
		{
			Name:        "disks.list",
			Description: "List the removable USB and SD drives and their partitions (device path, size, name, file system, where mounted), so you know the exact device for disks.mount, disks.unmount and disks.format_removable. Internal disks are never listed.",
			InputSchema: emptySchema,
			Risk:        mcp.RiskSafe, Call: d.listDisks,
		},
	}
}

// UserInfo is one users.list entry.
type UserInfo struct {
	Username string `json:"username"`
	FullName string `json:"fullName"`
}

func (d Deps) listUsers(_ context.Context, raw json.RawMessage) (any, error) {
	var none struct{}
	if err := mcp.DecodeArgs(raw, &none); err != nil {
		return nil, err
	}
	if d.FS == nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "the account list is not available")
	}
	b, err := fs.ReadFile(d.FS, "etc/passwd")
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "cannot read the account list: %v", err)
	}
	users := []UserInfo{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Split(sc.Text(), ":")
		if len(f) < 7 {
			continue
		}
		uid, err := strconv.Atoi(f[2])
		if err != nil || uid < 1000 || uid == 65534 {
			continue
		}
		name, _, _ := strings.Cut(f[4], ",") // GECOS: full name is the first field
		users = append(users, UserInfo{Username: f[0], FullName: name})
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Username < users[j].Username })
	return map[string]any{"users": users}, nil
}

// flex accepts a JSON bool, 0/1 or "0"/"1" (lsblk versions differ).
type flex bool

func (f *flex) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	*f = flex(s == "true" || s == "1")
	return nil
}

type blk struct {
	Path       string  `json:"path"`
	Type       string  `json:"type"`
	Size       int64   `json:"size"`
	Model      *string `json:"model"`
	Label      *string `json:"label"`
	FSType     *string `json:"fstype"`
	Mountpoint *string `json:"mountpoint"`
	Tran       *string `json:"tran"`
	RM         flex    `json:"rm"`
	Hotplug    flex    `json:"hotplug"`
	Children   []blk   `json:"children"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

// PartInfo and DiskInfo are the disks.list result shapes.
type PartInfo struct {
	Device     string `json:"device"`
	SizeBytes  int64  `json:"sizeBytes"`
	Label      string `json:"label"`
	FS         string `json:"fs"`
	Mountpoint string `json:"mountpoint"`
}

type DiskInfo struct {
	Device     string     `json:"device"`
	Name       string     `json:"name"`
	SizeBytes  int64      `json:"sizeBytes"`
	Partitions []PartInfo `json:"partitions"`
}

func (d Deps) listDisks(ctx context.Context, raw json.RawMessage) (any, error) {
	var none struct{}
	if err := mcp.DecodeArgs(raw, &none); err != nil {
		return nil, err
	}
	res, err := d.Run.Run(ctx, execx.Cmd{Name: "lsblk", Args: []string{"--json", "--bytes", "--paths", "--output", "PATH,TYPE,SIZE,MODEL,LABEL,FSTYPE,MOUNTPOINT,TRAN,RM,HOTPLUG"}, Timeout: 10 * time.Second})
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "lsblk: %v", err)
	}
	if res.ExitCode != 0 {
		return nil, mcp.Errorf(mcp.CodeFailed, "lsblk exit %d: %s", res.ExitCode, strings.TrimSpace(string(res.Stderr)))
	}
	var out struct {
		Blockdevices []blk `json:"blockdevices"`
	}
	if err := json.Unmarshal(res.Stdout, &out); err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "lsblk: unreadable output")
	}
	disks := []DiskInfo{}
	for _, b := range out.Blockdevices {
		removable := bool(b.RM) || bool(b.Hotplug) || str(b.Tran) == "usb"
		if b.Type != "disk" || !removable || !partRe.MatchString(b.Path) {
			continue
		}
		name := str(b.Model)
		if name == "" {
			name = cardText.Get(i18n.EN).UnknownDrive
		}
		di := DiskInfo{Device: b.Path, Name: name, SizeBytes: b.Size, Partitions: []PartInfo{}}
		for _, c := range b.Children {
			if c.Type != "part" || !partRe.MatchString(c.Path) {
				continue
			}
			di.Partitions = append(di.Partitions, PartInfo{Device: c.Path, SizeBytes: c.Size, Label: str(c.Label), FS: str(c.FSType), Mountpoint: str(c.Mountpoint)})
		}
		disks = append(disks, di)
	}
	return map[string]any{"disks": disks}, nil
}
