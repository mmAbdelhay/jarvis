package install

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
)

// fx reads a captured fixture from internal/parse/testdata.
func fx(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "parse", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// put writes a file under the fake root.
func put(t *testing.T, root, name, content string) {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const lsblkArgs = "-J -l -b -o PATH,PKNAME,TYPE,SIZE,MODEL,RM,RO,LOG-SEC"

// windowsMachine is a fake live system with the captured Windows disk.
func windowsMachine(t *testing.T) (*execx.Fake, *files.OS, string) {
	root := t.TempDir()
	put(t, root, "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c", "\x06\x00\x00\x00\x01")
	put(t, root, "/proc/meminfo", "MemTotal:       16113460 kB\nMemAvailable:   12000000 kB\n")
	put(t, root, "/proc/mounts", "/dev/sdb1 /run/live/medium iso9660 ro 0 0\n")
	put(t, root, "/dev/loop1p3", "\xebR\x90NTFS    \x00")
	put(t, root, "/dev/loop1p4", "\xebR\x90NTFS    \x00")
	put(t, root, "/usr/share/jarvis/models/catalog.json", `{"version":1,"models":[{"id":"small-4b","ollamaTag":"qwen3:4b","displayName":"Qwen3 4B","sizeBytes":2600000000,"minRamGB":8,"minVramGB":null,"tier":"small","toolCalling":"verified","languages":["en"],"recommendedFor":"8 GB"}]}`)
	put(t, root, "/usr/share/zoneinfo/Africa/Cairo", "TZif")
	run := (&execx.Fake{}).
		On(execx.OK(fx(t, "lsblk-windows.json")), "lsblk", strings.Fields(lsblkArgs)...).
		On(execx.OK("PTTYPE=gpt\n"), "blkid", "-p", "-o", "export", "/dev/loop1").
		On(execx.OK(fx(t, "sgdisk-p-windows.txt")), "sgdisk", "-p", "/dev/loop1").
		On(execx.OK(fx(t, "blkid-esp.txt")), "blkid", "-p", "-o", "export", "/dev/loop1p1").
		On(execx.OK(fx(t, "blkid-msr.txt")), "blkid", "-p", "-o", "export", "/dev/loop1p2").
		On(execx.OK(fx(t, "blkid-ntfs.txt")), "blkid", "-p", "-o", "export", "/dev/loop1p3").
		On(execx.OK(fx(t, "blkid-recovery.txt")), "blkid", "-p", "-o", "export", "/dev/loop1p4").
		On(execx.OK(fx(t, "ntfsresize-info-clean.txt")), "ntfsresize", "--info", "--no-progress-bar", "/dev/loop1p3").
		On(execx.OK(fx(t, "ntfsresize-info-clean.txt")), "ntfsresize", "--info", "--no-progress-bar", "/dev/loop1p4").
		On(execx.OK(""), "mount", "-t", "ntfs3", "-o", "ro,nosuid,nodev,noexec", "/dev/loop1p3", ntfsProbeDir).
		On(execx.OK(""), "mount", "-t", "ntfs3", "-o", "ro,nosuid,nodev,noexec", "/dev/loop1p4", ntfsProbeDir).
		On(execx.OK(""), "umount", ntfsProbeDir).
		On(execx.OK("full\n"), "nmcli", "-t", "networking", "connectivity", "check").
		On(execx.OK("00:02.0 VGA compatible controller: Intel Corporation Iris Xe Graphics\n\tKernel driver in use: i915\n"), "lspci", "-k")
	return run, &files.OS{Root: root}, root
}

func TestProbeWindowsMachine(t *testing.T) {
	run, fs, _ := windowsMachine(t)
	geo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `<Response><Ip>192.0.2.1</Ip><TimeZone>Africa/Cairo</TimeZone></Response>`)
	}))
	defer geo.Close()
	p, err := Probe(context.Background(), ProbeDeps{Run: run, Files: fs, HTTP: geo.Client(), GeoURL: geo.URL, AllowLoop: true})
	if err != nil {
		t.Fatal(err)
	}
	if !p.UEFI || !p.SecureBoot || p.RAMBytes != 16113460*1024 || !p.Online || p.GeoTimezone == nil || *p.GeoTimezone != "Africa/Cairo" {
		t.Fatalf("machine = %+v", p)
	}
	if p.GPU == nil || p.GPU.Name != "Intel Corporation Iris Xe Graphics" || p.GPU.VRAMBytes != nil {
		t.Fatalf("gpu = %+v", p.GPU)
	}
	if len(p.Catalog) != 1 || len(p.Disks) != 1 {
		t.Fatalf("catalog %d disks %d", len(p.Catalog), len(p.Disks))
	}
	d := p.Disks[0]
	if !d.GPT || d.SectorBytes != 512 || d.LastUsable != 134217694 || d.ESP == nil || *d.ESP != "/dev/loop1p1" || len(d.Partitions) != 4 {
		t.Fatalf("disk = %+v", d)
	}
	win := d.Partitions[2]
	want := Partition{Path: "/dev/loop1p3", FS: "ntfs", Label: "Windows", SizeBytes: 67523034624, UsedBytes: i64(70_000_000),
		NTFS:   &NTFSState{MinSizeBytes: 10_070_000_000},
		Number: 3, Start: 239616, End: 132120542, TypeGUID: basicDataTypeGUID, UniqueGUID: "a73a742f-a408-4a07-88a7-c7983f8ceee3", Name: "Basic data partition"}
	if !reflect.DeepEqual(win, want) {
		t.Fatalf("windows\n got %+v %+v\nwant %+v %+v", win, *win.NTFS, want, *want.NTFS)
	}
	if rec := d.Partitions[3]; rec.Flags != 1 || rec.TypeGUID != "de94bba4-06d1-4d40-a16a-bfd50179d6ac" {
		t.Fatalf("recovery = %+v", rec)
	}
	// The captured probe feeds the plan tests' hand-written disk exactly.
	if !reflect.DeepEqual(d.Partitions[2], windowsDisk().Partitions[2]) {
		t.Fatal("windowsDisk() in plan_test.go drifted from the probe of the captured fixtures")
	}
	// Probing changed nothing: every command was a read, the mount read-only.
	for _, c := range run.Calls {
		switch c.Name {
		case "lsblk", "blkid", "sgdisk", "ntfsresize", "nmcli", "lspci", "umount":
		case "mount":
			if c.Args[3] != "ro,nosuid,nodev,noexec" {
				t.Fatalf("non read-only mount: %v", c.Args)
			}
		default:
			t.Fatalf("probe ran %s", c.Name)
		}
		if c.Name == "sgdisk" && c.Args[0] != "-p" || c.Name == "ntfsresize" && c.Args[0] != "--info" {
			t.Fatalf("probe ran a writing form: %s %v", c.Name, c.Args)
		}
	}
}

func TestProbeDetectsHibernationDirtAndBitLocker(t *testing.T) {
	run, fs, root := windowsMachine(t)
	put(t, root, ntfsProbeDir+"/hiberfil.sys", "HIBR\x00\x00")
	run.On(execx.Result{ExitCode: 1, Stderr: []byte(fx(t, "ntfsresize-info-dirty.txt"))}, "ntfsresize", "--info", "--no-progress-bar", "/dev/loop1p3")
	put(t, root, "/dev/loop1p4", "\xebR\x90-FVE-FS-\x00")
	p, err := Probe(context.Background(), ProbeDeps{Run: run, Files: fs, AllowLoop: true})
	if err != nil {
		t.Fatal(err)
	}
	win, rec := p.Disks[0].Partitions[2], p.Disks[0].Partitions[3]
	if !win.NTFS.Hibernated || !win.NTFS.Dirty || win.NTFS.MinSizeBytes != win.SizeBytes {
		t.Fatalf("windows = %+v", *win.NTFS)
	}
	if rec.FS != "BitLocker" || !rec.NTFS.Bitlocker {
		t.Fatalf("signature not seen: %+v", rec)
	}
	if p.GeoTimezone != nil {
		t.Fatal("no HTTP client: no lookup")
	}
}

func TestProbeFailsClosedWhenNTFSCannotBeMounted(t *testing.T) {
	run, fs, _ := windowsMachine(t)
	run.On(execx.Exit(32, "unknown filesystem type 'ntfs3'"), "mount", "-t", "ntfs3", "-o", "ro,nosuid,nodev,noexec", "/dev/loop1p3", ntfsProbeDir)
	p, err := Probe(context.Background(), ProbeDeps{Run: run, Files: fs, AllowLoop: true})
	if err != nil {
		t.Fatal(err)
	}
	if !p.Disks[0].Partitions[2].NTFS.Hibernated {
		t.Fatal("an unreadable hibernation state must count as hibernated")
	}
}

func TestProbeReportsTheLiveMediumAndSkipsLoopsByDefault(t *testing.T) {
	run, fs, root := windowsMachine(t)
	put(t, root, "/proc/mounts", "/dev/loop1p1 /run/live/medium vfat ro 0 0\n")
	p, err := Probe(context.Background(), ProbeDeps{Run: run, Files: fs, AllowLoop: true})
	if err != nil || len(p.Disks) != 1 || p.LiveDevice == nil || *p.LiveDevice != "/dev/loop1" || p.MinRootBytes != 32212254720 {
		t.Fatalf("disks %d live %v min %d err %v", len(p.Disks), p.LiveDevice, p.MinRootBytes, err)
	}
	if _, err := MakePlan(choices("erase", "/dev/loop1"), p, "x"); refusal(t, err) != RefuseLiveMedium {
		t.Fatal("the live medium must be refused")
	}
	run2, fs2, _ := windowsMachine(t)
	if p, _ := Probe(context.Background(), ProbeDeps{Run: run2, Files: fs2}); len(p.Disks) != 0 {
		t.Fatal("loop devices are not disks on a real machine")
	}
}

func TestProbeNoUEFIAndOffline(t *testing.T) {
	run, fs, root := windowsMachine(t)
	os.RemoveAll(filepath.Join(root, "sys"))
	run.On(execx.OK("none\n"), "nmcli", "-t", "networking", "connectivity", "check")
	p, err := Probe(context.Background(), ProbeDeps{Run: run, Files: fs, AllowLoop: true})
	if err != nil || p.UEFI || p.SecureBoot || p.Online {
		t.Fatalf("got %+v, %v", p, err)
	}
	if _, err := MakePlan(choices("erase", "/dev/loop1"), p, "x"); refusal(t, err) != RefuseNoUEFI {
		t.Fatal("no-uefi")
	}
}
