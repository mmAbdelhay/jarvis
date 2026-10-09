//go:build linux

package install

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
)

// The dangerous steps for real, on loop devices: probe, plan, partition,
// encrypt and format a Windows-like disk and a blank disk. Root only, opt-in:
//
//	docker run --rm --privileged -v "$PWD":/src -w /src golang:1.24-trixie bash -c \
//	  'apt-get update -qq && apt-get install -y -qq gdisk ntfs-3g cryptsetup-bin dosfstools e2fsprogs fdisk >/dev/null &&
//	   JARVIS_LOOP_TESTS=1 go test -count=1 -v -run TestLoop ./internal/install'
//
// Containers have no udev, so a helper creates partition nodes from sysfs.

func sh(t *testing.T, name string, args ...string) string {
	t.Helper()
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}

func loopDisk(t *testing.T, size string) string {
	t.Helper()
	if os.Getenv("JARVIS_LOOP_TESTS") != "1" || os.Geteuid() != 0 {
		t.Skip("set JARVIS_LOOP_TESTS=1 and run as root (privileged container)")
	}
	img := filepath.Join(t.TempDir(), "disk.img")
	sh(t, "truncate", "-s", size, img)
	dev := strings.TrimSpace(sh(t, "losetup", "--show", "-f", "-P", img))
	t.Cleanup(func() { exec.Command("losetup", "-d", dev).Run() })
	return dev
}

// mknodParts creates /dev nodes for the loop device's partitions (no udev).
func mknodParts(dev string) {
	base := filepath.Base(dev)
	parts, _ := filepath.Glob("/sys/block/" + base + "/" + base + "p*")
	for _, p := range parts {
		node := "/dev/" + filepath.Base(p)
		devno, err := os.ReadFile(p + "/dev")
		if err != nil {
			continue
		}
		mm := strings.Split(strings.TrimSpace(string(devno)), ":")
		if st, err := os.Stat(node); err == nil && st.Mode()&os.ModeDevice != 0 {
			if cur, _ := exec.Command("stat", "-c", "%t:%T", node).Output(); len(cur) > 0 {
				os.Remove(node) // a stale node from an earlier table
			}
		}
		exec.Command("mknod", node, "b", mm[0], mm[1]).Run()
	}
}

func nodeKeeper(t *testing.T, dev string) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		for ctx.Err() == nil {
			mknodParts(dev)
			time.Sleep(100 * time.Millisecond)
		}
	}()
}

func realDeps(t *testing.T) (Deps, *events) {
	ev := &events{}
	env := append(execx.HelperEnv(), "DM_DISABLE_UDEV=1")
	return Deps{Run: &execx.OSRunner{Env: env}, Files: &files.OS{}, Log: NewLogger(os.Stderr, nil), Events: ev, Every: 100 * time.Millisecond}, ev
}

func TestLoopAlongsideShrinksWindowsSafely(t *testing.T) {
	dev := loopDisk(t, "64G")
	sh(t, "sgdisk", "--new=1:0:+100M", "--typecode=1:ef00", "--change-name=1:EFI system partition",
		"--new=2:0:+16M", "--typecode=2:0c01", "--new=3:0:-1G", "--typecode=3:0700", "--change-name=3:Basic data partition",
		"--new=4:0:0", "--typecode=4:2700", dev)
	sh(t, "partx", "-u", dev)
	mknodParts(dev)
	sh(t, "mkfs.vfat", "-F", "32", "-n", "SYSTEM", dev+"p1")
	sh(t, "mkntfs", "-Q", "-L", "Windows", dev+"p3")
	sh(t, "mkntfs", "-Q", "-L", "Recovery", dev+"p4")
	before := sh(t, "sgdisk", "-i", "3", dev)
	nodeKeeper(t, dev)

	p, err := Probe(context.Background(), ProbeDeps{Run: &execx.OSRunner{Env: execx.HelperEnv()}, Files: &files.OS{}, AllowLoop: true, Only: []string{dev}})
	if err != nil {
		t.Fatal(err)
	}
	var disk *Disk
	for i := range p.Disks {
		if p.Disks[i].Path == dev {
			disk = &p.Disks[i]
		}
	}
	if disk == nil || !disk.GPT || len(disk.Partitions) != 4 || disk.Partitions[2].NTFS == nil || disk.Partitions[2].NTFS.Hibernated {
		t.Fatalf("probe = %+v", disk)
	}
	p.UEFI = true
	c := choices("alongside", dev)
	c.Brain = Brain{Kind: "cloud"}
	pl, err := MakePlan(c, p, "loop")
	if err != nil {
		t.Fatal(err)
	}
	d, _ := realDeps(t)
	j := &job{d: d, pl: pl, sec: Secrets{UserPassword: "x", LUKSPassphrase: str(luksPass)}, rootDev: pl.Layout.Root.Path}
	j.secrets = []string{luksPass}
	defer j.cleanup()
	if err := j.preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := j.partition(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := j.encrypt(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := j.format(context.Background()); err != nil {
		t.Fatal(err)
	}

	after := sh(t, "sgdisk", "-i", "3", dev)
	keep := func(s, prefix string) string {
		for _, l := range strings.Split(s, "\n") {
			if strings.HasPrefix(l, prefix) {
				return l
			}
		}
		return ""
	}
	for _, k := range []string{"Partition GUID code:", "Partition unique GUID:", "First sector:", "Partition name:", "Attribute flags:"} {
		if keep(before, k) != keep(after, k) {
			t.Fatalf("Windows %s changed: %q -> %q", k, keep(before, k), keep(after, k))
		}
	}
	if !strings.Contains(after, fmt.Sprintf("Last sector: %d ", pl.Layout.Shrink.NewEnd)) {
		t.Fatalf("Windows last sector:\n%s", after)
	}
	// The shrunk NTFS is consistent (it is marked for chkdsk, as ntfsresize always does).
	if out, err := exec.Command("ntfsfix", "--no-action", dev+"p3").CombinedOutput(); err != nil {
		t.Fatalf("ntfsfix: %v\n%s", err, out)
	}
	if out := sh(t, "blkid", "-p", "-o", "export", pl.Layout.Root.Path); !strings.Contains(out, "TYPE=crypto_LUKS") || !strings.Contains(out, "VERSION=2") {
		t.Fatalf("root = %s", out)
	}
	if out := sh(t, "cryptsetup", "luksDump", pl.Layout.Root.Path); !strings.Contains(out, "argon2id") {
		t.Fatalf("pbkdf:\n%s", out)
	}
	if out := sh(t, "findmnt", "-n", "-o", "FSTYPE", Target); strings.TrimSpace(out) != "ext4" {
		t.Fatalf("/target = %q", out)
	}
	if st, err := os.Stat(Target + "/swapfile"); err != nil || st.Size() != SwapFileBytes || st.Mode().Perm() != 0o600 {
		t.Fatalf("swapfile %v %v", st, err)
	}
	// Recovery untouched.
	if out := sh(t, "blkid", "-p", "-o", "export", dev+"p4"); !strings.Contains(out, "LABEL=Recovery") {
		t.Fatalf("recovery = %s", out)
	}
	sh(t, "umount", "-R", Target)
	j.mounted = false
	sh(t, "cryptsetup", "close", mapperName)
	j.opened = false
	// The passphrase opens it again: it was passed exactly, with no newline.
	cmd := exec.Command("cryptsetup", "open", "--test-passphrase", "--key-file=-", pl.Layout.Root.Path)
	cmd.Stdin = strings.NewReader(luksPass)
	cmd.Env = append(os.Environ(), "DM_DISABLE_UDEV=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("passphrase does not open the volume: %v %s", err, out)
	}
}

func TestLoopEraseRefusesAChangedDiskThenInstalls(t *testing.T) {
	dev := loopDisk(t, "40G")
	nodeKeeper(t, dev)
	p, err := Probe(context.Background(), ProbeDeps{Run: &execx.OSRunner{Env: execx.HelperEnv()}, Files: &files.OS{}, AllowLoop: true, Only: []string{dev}})
	if err != nil {
		t.Fatal(err)
	}
	p.UEFI = true
	c := choices("erase", dev)
	c.Encrypt = false
	c.Brain = Brain{Kind: "cloud"}
	pl, err := MakePlan(c, p, "loop")
	if err != nil {
		t.Fatal(err)
	}
	d, _ := realDeps(t)
	// Someone partitions the disk between Review and Install.
	sh(t, "sgdisk", "--new=1:0:+1G", dev)
	j := &job{d: d, pl: pl, sec: Secrets{UserPassword: "x"}, rootDev: pl.Layout.Root.Path}
	if err := j.preflight(context.Background()); err == nil || err.Error() != text.DiskChanged {
		t.Fatalf("preflight = %v", err)
	}
	sh(t, "sgdisk", "--zap-all", dev)
	defer j.cleanup()
	for _, f := range []func(context.Context) error{j.preflight, j.partition, j.format} {
		if err := f(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	out := sh(t, "sgdisk", "-p", dev)
	if !strings.Contains(out, "EF00  EFI system partition") || !strings.Contains(out, "8304  Jarvis OS") {
		t.Fatalf("table:\n%s", out)
	}
	sh(t, "umount", "-R", Target)
	j.mounted = false
}
