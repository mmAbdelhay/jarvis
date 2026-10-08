package admintools

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
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

func describe(t *testing.T, d Deps, name, args string) mcp.Description {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			desc, err := tool.Describe(context.Background(), json.RawMessage(args))
			if err != nil {
				t.Fatal(err)
			}
			return desc
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

func TestToolsMatchContract(t *testing.T) {
	got := map[string]mcp.Risk{}
	for _, tool := range Tools(Deps{}) {
		got[tool.Name] = tool.Risk
		if tool.Hidden || tool.Batch != "" {
			t.Errorf("%s: plain tool expected", tool.Name)
		}
		wantSecrets := map[string][]string{"users.add": {"adminPassword", "newPassword"}, "users.remove": {"adminPassword"}, "disks.format_removable": {"adminPassword"}}[tool.Name]
		if !reflect.DeepEqual(tool.Secrets, wantSecrets) {
			t.Errorf("%s: secrets %v, want %v", tool.Name, tool.Secrets, wantSecrets)
		}
	}
	want := map[string]mcp.Risk{"users.list": mcp.RiskSafe, "disks.list": mcp.RiskSafe, "users.add": mcp.RiskPassword, "users.remove": mcp.RiskPassword, "disks.format_removable": mcp.RiskPassword, "disks.mount": mcp.RiskConfirm, "disks.unmount": mcp.RiskConfirm}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tools %v", got)
	}
	if err := (&mcp.Server{Name: "jarvis-settings", Tools: Tools(Deps{})}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestUsersGoThroughTheHelper(t *testing.T) {
	h := &helperapi.Fake{}
	d := Deps{Helper: h}
	if _, err := call(t, d, "users.add", `{"username":"lina","fullName":"Lina Ali","adminPassword":"admin-pw","newPassword":"new-pw"}`); err != nil {
		t.Fatal(err)
	}
	m, err := call(t, d, "users.remove", `{"username":"kid","keepHome":true,"adminPassword":"admin-pw"}`)
	if err != nil || m["keptHome"] != true || m["undo"] != nil {
		t.Fatalf("remove %v %v", m, err)
	}
	if !reflect.DeepEqual(h.Called(), []string{"AddUser lina Lina Ali", "RemoveUser kid keepHome=true"}) {
		t.Fatalf("helper calls %v", h.Called())
	}
	for args, want := range map[string]mcp.Code{`{"username":"Root","adminPassword":"a","newPassword":"b"}`: mcp.CodeInvalid, `{"username":"root","adminPassword":"a","newPassword":"b"}`: mcp.CodeInvalid, `{"username":"x","fullName":"a:b","adminPassword":"a","newPassword":"b"}`: mcp.CodeInvalid, `{"username":"x","newPassword":"b"}`: mcp.CodeInvalid, `{"username":"x","adminPassword":"a"}`: mcp.CodeInvalid, `{"username":"x","adminPassword":"a","newPassword":"b\nc"}`: mcp.CodeInvalid} {
		if _, err := call(t, d, "users.add", args); codeOf(err) != want {
			t.Errorf("%s: %v", args, err)
		}
	}
	if len(h.Called()) != 2 {
		t.Fatal("invalid input must never reach the helper")
	}
	h.Reply = func(string, []string) (helperapi.Outcome, error) {
		return helperapi.Outcome{}, &helperapi.Error{Name: helperapi.ErrNotAllowed, Message: "sara is the last administrator"}
	}
	if _, err := call(t, d, "users.remove", `{"username":"sara","adminPassword":"admin-pw"}`); codeOf(err) != mcp.CodeNotAllowed || !strings.Contains(err.Error(), "last administrator") {
		t.Fatalf("refusal: %v", err)
	}
	h.Reply = func(string, []string) (helperapi.Outcome, error) {
		return helperapi.Outcome{}, &helperapi.Error{Name: helperapi.ErrDenied, Message: "not authorized: polkit refused os.jarvis.helper.admin"}
	}
	if _, err := call(t, d, "users.add", `{"username":"lina","adminPassword":"wrong","newPassword":"new-pw"}`); codeOf(err) != mcp.CodeDenied {
		t.Fatalf("wrong password: %v", err)
	}
	h.Reply = func(string, []string) (helperapi.Outcome, error) {
		return helperapi.Outcome{OK: false, ExitCode: 8, StderrTail: "userdel: user kid is currently used by process 4242\n"}, nil
	}
	if _, err := call(t, d, "users.remove", `{"username":"kid","adminPassword":"admin-pw"}`); codeOf(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "currently used") {
		t.Fatalf("failed run: %v", err)
	}
}

func TestFormatCardNamesTheDrive(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(`{"blockdevices":[{"model":"SanDisk Ultra  ","size":32017047552}]}`), "lsblk", "--json", "--bytes", "--nodeps", "--output", "MODEL,SIZE", "--", "/dev/sdb")
	h := &helperapi.Fake{}
	d := Deps{Run: run, Helper: h}
	desc := describe(t, d, "disks.format_removable", `{"device":"/dev/sdb","fs":"exfat","label":"USB"}`)
	if desc.Title != "Erase and format /dev/sdb as exfat" || !strings.HasPrefix(desc.Detail, "Everything on /dev/sdb (SanDisk Ultra, 32 GB) is lost.") {
		t.Fatalf("card %+v", desc)
	}
	if _, err := call(t, d, "disks.format_removable", `{"device":"/dev/sdb","fs":"exfat","label":"USB","adminPassword":"admin-pw"}`); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(h.Called(), []string{"FormatRemovable /dev/sdb exfat USB"}) {
		t.Fatalf("helper %v", h.Called())
	}
	for _, bad := range []string{`{"device":"/dev/nvme0n1","fs":"exfat","adminPassword":"a"}`, `{"device":"/dev/sdb1","fs":"exfat","adminPassword":"a"}`, `{"device":"/dev/sdb","fs":"ntfs","adminPassword":"a"}`, `{"device":"/dev/sdb","fs":"vfat","label":"TOO LONG NAME","adminPassword":"a"}`, `{"device":"/dev/sdb","fs":"exfat"}`} {
		if _, err := call(t, d, "disks.format_removable", bad); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", bad, err)
		}
	}
}

func TestMountUnmount(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Mounted /dev/sdb1 at /media/sara/USB\n"), "udisksctl", "mount", "--block-device", "/dev/sdb1", "--no-user-interaction").
		On(execx.OK("Unmounted /dev/sdb1.\n"), "udisksctl", "unmount", "--block-device", "/dev/sdb1", "--no-user-interaction").
		On(execx.Exit(1, "Error mounting /dev/sda2: GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorizedCanObtain: Not authorized to perform operation\n"), "udisksctl", "mount", "--block-device", "/dev/sda2", "--no-user-interaction")
	d := Deps{Run: run}
	m, err := call(t, d, "disks.mount", `{"device":"/dev/sdb1"}`)
	if err != nil || m["mountpoint"] != "/media/sara/USB" || !reflect.DeepEqual(m["undo"], map[string]any{"tool": "disks.unmount", "input": map[string]any{"device": "/dev/sdb1"}}) {
		t.Fatalf("mount %v %v", m, err)
	}
	m, err = call(t, d, "disks.unmount", `{"device":"/dev/sdb1"}`)
	if err != nil || m["undo"].(map[string]any)["tool"] != "disks.mount" {
		t.Fatalf("unmount %v %v", m, err)
	}
	if _, err := call(t, d, "disks.mount", `{"device":"/dev/sda2"}`); codeOf(err) != mcp.CodeDenied {
		t.Fatalf("system disk: %v", err)
	}
	for _, bad := range []string{"/dev/nvme0n1p2", "/dev/sdb1; ls", "/dev/mapper/root", "sdb1"} {
		if _, err := call(t, d, "disks.mount", `{"device":"`+bad+`"}`); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestPasswordsNeverLeakIntoErrorsOrCards(t *testing.T) {
	h := &helperapi.Fake{}
	d := Deps{Helper: h}
	_, err := call(t, d, "users.add", `{"username":"x","adminPassword":"s3cret-admin","newPassword":"bad\nnew-s3cret"}`)
	if codeOf(err) != mcp.CodeInvalid || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("err %v", err)
	}
	desc := describe(t, d, "users.add", `{"username":"x"}`)
	if strings.Contains(desc.Title+desc.Detail, "s3cret") {
		t.Fatal("card leaks a secret")
	}
	if strings.Join(h.Called(), "") != "" {
		t.Fatal("invalid input reached the helper")
	}
}

func TestUsersListHumansOnly(t *testing.T) {
	d := Deps{FS: fstest.MapFS{"etc/passwd": {Data: []byte("root:x:0:0:root:/root:/bin/bash\nlina:x:1000:1000:Lina Ali,,,:/home/lina:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nsvc:x:999:999::/var/lib/svc:/usr/sbin/nologin\nbob:x:1001:1001::/home/bob:/bin/bash\n")}}}
	v, err := call(t, d, "users.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v["users"])
	if string(b) != `[{"fullName":"","username":"bob"},{"fullName":"Lina Ali","username":"lina"}]` {
		t.Fatalf("users %s", b)
	}
	if _, err := call(t, Deps{}, "users.list", `{}`); codeOf(err) != mcp.CodeFailed {
		t.Fatalf("no FS: %v", err)
	}
	if _, err := call(t, d, "users.list", `{"x":1}`); codeOf(err) != mcp.CodeInvalid {
		t.Fatalf("extra arg: %v", err)
	}
}

func TestDisksListRemovableOnly(t *testing.T) {
	lsblk := `{"blockdevices":[
	 {"path":"/dev/sda","type":"disk","size":500107862016,"model":"Internal SSD","tran":"sata","rm":false,"hotplug":false,"children":[{"path":"/dev/sda1","type":"part","size":1,"fstype":"ext4","mountpoint":"/"}]},
	 {"path":"/dev/sdb","type":"disk","size":32017047552,"model":"SanDisk Ultra  ","tran":"usb","rm":"1","hotplug":true,"children":[
	   {"path":"/dev/sdb1","type":"part","size":32000000000,"label":"PHOTOS","fstype":"exfat","mountpoint":"/media/lina/PHOTOS"}]},
	 {"path":"/dev/loop0","type":"loop","size":5,"rm":false,"hotplug":false}]}`
	run := (&execx.Fake{}).On(execx.OK(lsblk), "lsblk", "--json", "--bytes", "--paths", "--output", "PATH,TYPE,SIZE,MODEL,LABEL,FSTYPE,MOUNTPOINT,TRAN,RM,HOTPLUG")
	v, err := call(t, Deps{Run: run}, "disks.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v["disks"])
	want := `[{"device":"/dev/sdb","name":"SanDisk Ultra","partitions":[{"device":"/dev/sdb1","fs":"exfat","label":"PHOTOS","mountpoint":"/media/lina/PHOTOS","sizeBytes":32000000000}],"sizeBytes":32017047552}]`
	if string(b) != want {
		t.Fatalf("disks %s", b)
	}
}
