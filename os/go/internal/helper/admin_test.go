package helper

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

type fixedCaller uint32

func (c fixedCaller) UnixUser(context.Context, string) (uint32, error) { return uint32(c), nil }

var etc = fstest.MapFS{
	"passwd": {Data: []byte("root:x:0:0:root:/root:/bin/bash\n" +
		"pulse:x:117:124::/run/pulse:/usr/sbin/nologin\n" +
		"sara:x:1000:1000:Sara:/home/sara:/bin/bash\n" +
		"omar:x:1001:1001:Omar:/home/omar:/bin/bash\n" +
		"kid:x:1002:1002:Kid:/home/kid:/bin/bash\n")},
	"group": {Data: []byte("root:x:0:\nsudo:x:27:sara,omar\nkid:x:1002:\n")},
}

// fakePAM accepts the password "right" for every user.
type fakePAM struct{ checked []string }

func (p *fakePAM) Verify(_ context.Context, user, password string) error {
	p.checked = append(p.checked, user)
	if password != "right" {
		return ErrBadPassword
	}
	return nil
}

func adminService(run *execx.Fake, auth *fakeAuth, caller uint32) *Service {
	s := newService(run, auth)
	s.Callers, s.Etc, s.Pass = fixedCaller(caller), etc, &fakePAM{}
	return s
}

func TestAddUser(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(""), "useradd", "--create-home", "--user-group", "--shell", "/bin/bash", "--comment", "Lina Ali", "--", "lina").
		On(execx.OK(""), "chpasswd")
	auth := &fakeAuth{}
	out, err := adminService(run, auth, 1000).AddUser(context.Background(), sender, "right", "lina", "Lina Ali", "s3cret")
	if err != nil || !out.OK {
		t.Fatalf("%+v %v", out, err)
	}
	if !reflect.DeepEqual(auth.actions, []string{sender + " " + helperapi.ActionAdmin}) {
		t.Fatalf("authorized %v", auth.actions)
	}
	if cp := run.CallsTo("chpasswd"); len(cp) != 1 || string(cp[0].Stdin) != "lina:s3cret\n" || len(cp[0].Args) != 0 {
		t.Fatalf("password must go over stdin only: %+v", cp)
	}
	for _, c := range []struct{ user, full, code string }{
		{"omar", "", helperapi.ErrInvalid}, // exists
		{"root", "", helperapi.ErrInvalid}, // system name
		{"Lina", "", helperapi.ErrInvalid}, // shape
		{"lina", "a:b", helperapi.ErrInvalid},
	} {
		_, err := adminService(&execx.Fake{}, &fakeAuth{}, 1000).AddUser(context.Background(), sender, "right", c.user, c.full, "pw")
		if helperErr(t, err).Name != c.code {
			t.Errorf("%v: %v", c, err)
		}
	}
	run = &execx.Fake{}
	_, err = adminService(run, &fakeAuth{deny: true}, 1000).AddUser(context.Background(), sender, "right", "lina", "", "pw")
	if helperErr(t, err).Name != helperapi.ErrDenied || len(run.Calls) != 0 {
		t.Fatalf("denied: %v, ran %v", err, run.Calls)
	}
}

func TestRemoveUser(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(""), "userdel", "--remove", "--", "kid").
		On(execx.OK(""), "userdel", "--", "omar")
	s := adminService(run, &fakeAuth{}, 1000)
	if out, err := s.RemoveUser(context.Background(), sender, "right", "kid", false); err != nil || !out.OK {
		t.Fatalf("remove kid: %+v %v", out, err)
	}
	if out, err := s.RemoveUser(context.Background(), sender, "right", "omar", true); err != nil || !out.OK {
		t.Fatalf("remove omar keeping home: %+v %v", out, err)
	}
	for _, c := range []struct {
		user   string
		caller uint32
		code   string
		why    string
	}{
		{"sara", 1000, helperapi.ErrNotAllowed, "yourself"},
		{"pulse", 1000, helperapi.ErrNotAllowed, "system account"},
		{"ghost", 1000, helperapi.ErrNotFound, "missing"},
		{"root", 1000, helperapi.ErrInvalid, "reserved name"},
	} {
		_, err := adminService(&execx.Fake{}, &fakeAuth{}, c.caller).RemoveUser(context.Background(), sender, "right", c.user, false)
		if helperErr(t, err).Name != c.code {
			t.Errorf("%s: %v", c.why, err)
		}
	}
	lastAdmin := fstest.MapFS{"passwd": etc["passwd"], "group": {Data: []byte("sudo:x:27:sara\n")}}
	s = adminService(&execx.Fake{}, &fakeAuth{}, 1001)
	s.Etc = lastAdmin
	_, err := s.RemoveUser(context.Background(), sender, "right", "sara", false)
	if he := helperErr(t, err); he.Name != helperapi.ErrNotAllowed || !strings.Contains(he.Message, "last administrator") {
		t.Fatalf("last admin: %v", err)
	}
}

const lsblkArgs = "--json --bytes --output NAME,PATH,TYPE,RM,TRAN,MOUNTPOINTS"

const lsblkJSON = `{"blockdevices":[
 {"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","rm":false,"tran":"nvme","mountpoints":[null],
  "children":[{"name":"nvme0n1p1","path":"/dev/nvme0n1p1","type":"part","rm":false,"tran":null,"mountpoints":["/boot/efi"]},
              {"name":"nvme0n1p2","path":"/dev/nvme0n1p2","type":"part","rm":false,"tran":null,"mountpoints":["/"]}]},
 {"name":"sda","path":"/dev/sda","type":"disk","rm":false,"tran":"sata","mountpoints":[null]},
 {"name":"sdb","path":"/dev/sdb","type":"disk","rm":true,"tran":"usb","mountpoints":[null],
  "children":[{"name":"sdb1","path":"/dev/sdb1","type":"part","rm":true,"tran":null,"mountpoints":[null]}]},
 {"name":"sdc","path":"/dev/sdc","type":"disk","rm":"1","tran":"usb","mountpoints":[null],
  "children":[{"name":"sdc1","path":"/dev/sdc1","type":"part","rm":"1","tran":null,"mountpoints":["/media/sara/USB"]}]},
 {"name":"mmcblk0","path":"/dev/mmcblk0","type":"disk","rm":true,"tran":null,"mountpoints":[null]},
 {"name":"sde","path":"/dev/sde","type":"disk","rm":false,"tran":"usb","mountpoints":[null]},
 {"name":"sdf","path":"/dev/sdf","type":"disk","rm":false,"tran":"usb","mountpoints":[null],
  "children":[{"name":"sdf1","path":"/dev/sdf1","type":"part","rm":false,"tran":null,"mountpoints":[null],
               "children":[{"name":"boot-crypt","path":"/dev/mapper/boot-crypt","type":"crypt","rm":false,"tran":null,"mountpoints":[null]}]}]}
]}`

// hintSystem registers udisks2's Block.HintSystem answer for a disk name.
func hintSystem(f *execx.Fake, name string, system bool) *execx.Fake {
	v := "b false\n"
	if system {
		v = "b true\n"
	}
	return f.On(execx.OK(v), "busctl", "get-property", "org.freedesktop.UDisks2", "/org/freedesktop/UDisks2/block_devices/"+name, "org.freedesktop.UDisks2.Block", "HintSystem")
}

func findmntArgs(target string) []string {
	return []string{"--noheadings", "--output", "SOURCE", "--mountpoint", target}
}

func formatRun() *execx.Fake {
	f := &execx.Fake{}
	for _, d := range []string{"sdb", "sdc", "mmcblk0", "sde", "sdf"} {
		hintSystem(f, d, false)
	}
	hintSystem(f, "sda", true)
	return f.
		On(execx.OK(lsblkJSON), "lsblk", strings.Fields(lsblkArgs)...).
		// "/" is a btrfs subvolume; /boot sits on an encrypted partition of
		// sdf that lsblk (in the helper's mount namespace) shows unmounted.
		On(execx.OK("/dev/nvme0n1p2[/@rootfs]\n"), "findmnt", findmntArgs("/")...).
		On(execx.OK("/dev/mapper/boot-crypt\n"), "findmnt", findmntArgs("/boot")...).
		On(execx.OK(""), "wipefs", "--all", "--force", "--", "/dev/sde").
		On(execx.OK(""), "sfdisk", "--quiet", "--wipe", "always", "--wipe-partitions", "always", "--", "/dev/sde").
		On(execx.OK(""), "mkfs.exfat", "--", "/dev/sde1").
		On(execx.OK(""), "mkfs.exfat", "--", "/dev/sdb1").
		On(execx.OK(""), "wipefs", "--all", "--force", "--", "/dev/sdb").
		On(execx.OK(""), "sfdisk", "--quiet", "--wipe", "always", "--wipe-partitions", "always", "--", "/dev/sdb").
		On(execx.OK(""), "udevadm", "settle", "--timeout=15").
		On(execx.OK(""), "mkfs.exfat", "-L", "My USB", "--", "/dev/sdb1").
		On(execx.OK(""), "mkfs.vfat", "-F", "32", "-n", "PHOTOS", "--", "/dev/sdb1").
		On(execx.OK(""), "mkfs.ext4", "-F", "-q", "-E", "root_owner=1000:1000", "--", "/dev/sdb1").
		On(execx.OK(""), "wipefs", "--all", "--force", "--", "/dev/mmcblk0").
		On(execx.OK(""), "sfdisk", "--quiet", "--wipe", "always", "--wipe-partitions", "always", "--", "/dev/mmcblk0").
		On(execx.OK(""), "mkfs.exfat", "--", "/dev/mmcblk0p1")
}

func TestFormatRemovable(t *testing.T) {
	run := formatRun()
	s := adminService(run, &fakeAuth{}, 1000)
	for _, c := range []struct{ dev, fs, label string }{{"/dev/sdb", "exfat", "My USB"}, {"/dev/sdb", "vfat", "photos"}, {"/dev/sdb", "ext4", ""}, {"/dev/mmcblk0", "exfat", ""}, {"/dev/sde", "exfat", ""}} {
		out, err := s.FormatRemovable(context.Background(), sender, "right", c.dev, c.fs, c.label)
		if err != nil || !out.OK {
			t.Fatalf("%v: %+v %v", c, out, err)
		}
	}
	for _, c := range run.CallsTo("sfdisk") {
		if string(c.Stdin) != "label: dos\ntype=7\n" && string(c.Stdin) != "label: dos\ntype=c\n" && string(c.Stdin) != "label: dos\ntype=83\n" {
			t.Fatalf("sfdisk script %q", c.Stdin)
		}
	}
	if got := string(run.CallsTo("sfdisk")[1].Stdin); got != "label: dos\ntype=c\n" {
		t.Fatalf("vfat partition type: %q", got)
	}
}

func TestFormatRemovableRefusals(t *testing.T) {
	for _, c := range []struct{ dev, code, why string }{
		{"/dev/sda", helperapi.ErrNotAllowed, "internal SATA disk (udisks HintSystem=true)"},
		{"/dev/sdf", helperapi.ErrNotAllowed, "hosts /boot"},
		{"/dev/sdc", helperapi.ErrNotAllowed, "a partition is mounted"},
		{"/dev/sdd", helperapi.ErrNotFound, "not connected"},
		{"/dev/nvme0n1", helperapi.ErrInvalid, "system NVMe disk"},
		{"/dev/sdb1", helperapi.ErrInvalid, "a partition, not a disk"},
	} {
		run := formatRun()
		_, err := adminService(run, &fakeAuth{}, 1000).FormatRemovable(context.Background(), sender, "right", c.dev, "exfat", "")
		if helperErr(t, err).Name != c.code {
			t.Errorf("%s: %v", c.why, err)
		}
		if len(run.CallsTo("wipefs")) != 0 {
			t.Errorf("%s: wipefs ran", c.why)
		}
	}
	for _, broken := range []*execx.Fake{
		formatRun().On(execx.Exit(1, ""), "findmnt", findmntArgs("/")...),
		formatRun().On(execx.Exit(1, "Failed to get property HintSystem\n"), "busctl", "get-property", "org.freedesktop.UDisks2", "/org/freedesktop/UDisks2/block_devices/sdb", "org.freedesktop.UDisks2.Block", "HintSystem"),
	} {
		_, err := adminService(broken, &fakeAuth{}, 1000).FormatRemovable(context.Background(), sender, "right", "/dev/sdb", "exfat", "")
		if err == nil || len(broken.CallsTo("wipefs")) != 0 {
			t.Fatalf("an unverifiable drive is refused: %v", err)
		}
	}
	// No separate /boot is fine.
	run := formatRun().On(execx.Exit(1, ""), "findmnt", findmntArgs("/boot")...)
	if out, err := adminService(run, &fakeAuth{}, 1000).FormatRemovable(context.Background(), sender, "right", "/dev/sdb", "exfat", ""); err != nil || !out.OK {
		t.Fatalf("no /boot mount: %+v %v", out, err)
	}
	run = formatRun().On(execx.Exit(1, "sfdisk: cannot open /dev/sdb: Device or resource busy\n"), "sfdisk", "--quiet", "--wipe", "always", "--wipe-partitions", "always", "--", "/dev/sdb")
	out, err := adminService(run, &fakeAuth{}, 1000).FormatRemovable(context.Background(), sender, "right", "/dev/sdb", "exfat", "")
	if err != nil || out.OK || !strings.Contains(out.StderrTail, "busy") || len(run.CallsTo("mkfs.exfat")) != 0 {
		t.Fatalf("a failed step stops the format: %+v %v", out, err)
	}
	run = formatRun()
	_, err = adminService(run, &fakeAuth{deny: true}, 1000).FormatRemovable(context.Background(), sender, "right", "/dev/sdb", "exfat", "")
	if helperErr(t, err).Name != helperapi.ErrDenied || len(run.Calls) != 0 {
		t.Fatalf("denied before lsblk: %v %v", err, run.Calls)
	}
}

// The real authorizer is also the CallerUIDs main wires in.
func TestSystemAuthorizerReportsTheCallerUID(t *testing.T) {
	var c CallerUIDs = SystemAuthorizer{Bus: userBus(true)}
	if uid, err := c.UnixUser(context.Background(), sender); err != nil || uid != 1000 {
		t.Fatalf("uid %d %v", uid, err)
	}
	if _, err := (SystemAuthorizer{Bus: &fakeBus{}}).UnixUser(context.Background(), sender); err == nil {
		t.Fatal("an unknown caller must fail")
	}
}

func TestAddUserRollsBackWhenThePasswordCannotBeSet(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(""), "useradd", "--create-home", "--user-group", "--shell", "/bin/bash", "--comment", "", "--", "lina").
		On(execx.Exit(1, "chpasswd: bad\n"), "chpasswd").
		On(execx.OK(""), "userdel", "--remove", "--", "lina")
	out, err := adminService(run, &fakeAuth{}, 1000).AddUser(context.Background(), sender, "right", "lina", "", "pw")
	if err != nil || out.OK || !run.Ran("userdel", "--remove", "--", "lina") {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestAdminPasswordGate(t *testing.T) {
	for _, pw := range []string{"wrong", ""} {
		run, pam := &execx.Fake{}, &fakePAM{}
		s := adminService(run, &fakeAuth{}, 1000)
		s.Pass = pam
		_, err := s.RemoveUser(context.Background(), sender, pw, "kid", false)
		if helperErr(t, err).Name != helperapi.ErrDenied || len(run.Calls) != 0 {
			t.Fatalf("%q: %v ran %v", pw, err, run.Calls)
		}
	}
	// The password is checked for the CALLING user, not the target.
	pam := &fakePAM{}
	run := (&execx.Fake{}).On(execx.OK(""), "userdel", "--remove", "--", "kid")
	s := adminService(run, &fakeAuth{}, 1000)
	s.Pass = pam
	if _, err := s.RemoveUser(context.Background(), sender, "right", "kid", false); err != nil || len(pam.checked) != 1 || pam.checked[0] != "sara" {
		t.Fatalf("checked %v %v", pam.checked, err)
	}
}

func TestAdminPasswordThrottle(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	pam := &fakePAM{}
	run := (&execx.Fake{}).On(execx.OK(""), "userdel", "--remove", "--", "kid")
	s := adminService(run, &fakeAuth{}, 1000)
	s.Pass, s.Now = pam, func() time.Time { return now }
	try := func(pw string) error {
		_, err := s.RemoveUser(context.Background(), sender, pw, "kid", false)
		return err
	}
	for i := 0; i < 3; i++ {
		if helperErr(t, try("bad")).Name != helperapi.ErrDenied {
			t.Fatal("wrong password must be denied")
		}
	}
	if err := try("right"); helperErr(t, err).Name != helperapi.ErrDenied || !strings.Contains(err.Error(), "too many") || len(pam.checked) != 3 {
		t.Fatalf("locked out: %v, %d checks", err, len(pam.checked))
	}
	// The lockout lives in memory, so the helper must not idle-exit while it
	// holds one, whatever main's idleExit is (D-Bus activation would start a
	// fresh process with no lockout).
	if d := s.IdleFor(now.Add(5*time.Minute - time.Second)); d != 0 {
		t.Fatalf("idle %v while locked out", d)
	}
	now = now.Add(5*time.Minute + time.Second)
	if d := s.IdleFor(now); d == 0 {
		t.Fatal("still busy after the lockout expired")
	}
	if err := try("right"); err != nil {
		t.Fatalf("lock expires: %v", err)
	}
	// Failures older than the window do not add up.
	pam2 := &fakePAM{}
	s2 := adminService(&execx.Fake{}, &fakeAuth{}, 1000)
	s2.Pass, s2.Now = pam2, func() time.Time { return now }
	for i := 0; i < 5; i++ {
		now = now.Add(3 * time.Minute)
		_, err := s2.RemoveUser(context.Background(), sender, "bad", "kid", false)
		if strings.Contains(err.Error(), "too many") {
			t.Fatalf("attempt %d locked out", i)
		}
	}
}

func TestPAMVerifierUsesStdinOnly(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(""), "unix_chkpwd", "sara", "nonull")
	if err := (PAMVerifier{Run: run}).Verify(context.Background(), "sara", "pw"); err != nil {
		t.Fatal(err)
	}
	if c := run.CallsTo("unix_chkpwd")[0]; string(c.Stdin) != "pw\x00" {
		t.Fatalf("stdin %q", c.Stdin)
	}
	run = (&execx.Fake{}).On(execx.Exit(7, ""), "unix_chkpwd", "sara", "nonull")
	if err := (PAMVerifier{Run: run}).Verify(context.Background(), "sara", "pw"); !errors.Is(err, ErrBadPassword) {
		t.Fatalf("%v", err)
	}
	for _, code := range []int{4, 10} {
		run = (&execx.Fake{}).On(execx.Exit(code, ""), "unix_chkpwd", "sara", "nonull")
		if err := (PAMVerifier{Run: run}).Verify(context.Background(), "sara", "pw"); err == nil || errors.Is(err, ErrBadPassword) {
			t.Fatalf("exit %d: %v", code, err)
		}
	}
}
