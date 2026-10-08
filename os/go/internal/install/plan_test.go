package install

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/catalog"
)

// windowsDisk is the captured 64 GiB loop disk (parse/testdata
// sgdisk-p-windows.txt + blkid-*.txt): a 100 MB Windows ESP (too small to
// share), MSR, the Windows NTFS volume and a Recovery partition right after.
func windowsDisk() Disk {
	return Disk{
		Path: "/dev/loop1", Model: "", SizeBytes: 68719476736, GPT: true, SectorBytes: 512, FirstUsable: 34, LastUsable: 134217694,
		ESP: str("/dev/loop1p1"),
		Partitions: []Partition{
			{Path: "/dev/loop1p1", FS: "vfat", Label: "SYSTEM", SizeBytes: 104857600, Number: 1, Start: 2048, End: 206847, TypeGUID: espTypeGUID, Name: "EFI system partition"},
			{Path: "/dev/loop1p2", FS: "", SizeBytes: 16777216, Number: 2, Start: 206848, End: 239615, TypeGUID: "e3c9e316-0b5c-4db8-817d-f92df00215ae", Name: "Microsoft reserved partition"},
			{Path: "/dev/loop1p3", FS: "ntfs", Label: "Windows", SizeBytes: 67523034624, UsedBytes: i64(70_000_000), Number: 3, Start: 239616, End: 132120542,
				TypeGUID: basicDataTypeGUID, UniqueGUID: "a73a742f-a408-4a07-88a7-c7983f8ceee3", Name: "Basic data partition",
				NTFS: &NTFSState{MinSizeBytes: 10_070_000_000}},
			{Path: "/dev/loop1p4", FS: "ntfs", Label: "Recovery", SizeBytes: 1073724928, Number: 4, Start: 132120576, End: 134217694,
				TypeGUID: "de94bba4-06d1-4d40-a16a-bfd50179d6ac", Flags: 1, NTFS: &NTFSState{MinSizeBytes: 1073724928}},
		},
	}
}

// emptyDisk is the captured blank 16 GiB disk... grown to 256 GB so an
// erase fits; geometry as sgdisk reports it for 500118192 sectors.
func emptyDisk() Disk {
	return Disk{Path: "/dev/nvme0n1", Model: "Samsung SSD 980", SizeBytes: 256060514304, SectorBytes: 512, FirstUsable: 34, LastUsable: 500118158, Partitions: []Partition{}}
}

var testCatalog = []ProbeModel{
	{Model: catalog.Model{ID: "qwen3-8b", OllamaTag: "qwen3:8b", DisplayName: "Qwen3 8B", SizeBytes: 5_200_000_000, MinRamGB: 16, Tier: "medium", ToolCalling: "verified"}},
	{Model: catalog.Model{ID: "small-4b", OllamaTag: "qwen3:4b", DisplayName: "Qwen3 4B", SizeBytes: 2_600_000_000, MinRamGB: 8, Tier: "small", ToolCalling: "verified"}},
	{Model: catalog.Model{ID: "gpu-32b", OllamaTag: "qwen3:32b", DisplayName: "Qwen3 32B", SizeBytes: 20_000_000_000, MinRamGB: 32, MinVramGB: func() *float64 { v := 24.0; return &v }(), Tier: "gpu", ToolCalling: "verified"}},
}

func probe(disks ...Disk) ProbeResult {
	return ProbeResult{UEFI: true, SecureBoot: true, RAMBytes: 16_500_000_000, Online: true, Disks: disks, Catalog: testCatalog}
}

func choices(mode, disk string) Choices {
	c := Choices{Locale: "en_US.UTF-8", Keyboard: "us", Timezone: "Africa/Cairo", Encrypt: true,
		Disk:  DiskChoice{Path: disk, Mode: mode},
		User:  UserChoice{FullName: "Ada Lovelace", Username: "ada", Hostname: "ada-laptop"},
		Brain: Brain{Kind: "local", ModelID: "small-4b"}}
	if mode == "alongside" {
		c.Disk.AlongsideSizeBytes = i64(40_000_000_000)
	}
	return c
}

func TestPlanEraseExact(t *testing.T) {
	pl, err := MakePlan(choices("erase", "/dev/nvme0n1"), probe(emptyDisk()), "p1")
	if err != nil {
		t.Fatal(err)
	}
	wantLayout := Layout{Mode: "erase", Disk: "/dev/nvme0n1", SectorBytes: 512, Wipe: true, Encrypt: true, FallbackBoot: true,
		ESP:  Part{Path: "/dev/nvme0n1p1", Number: 1, Create: true, Format: true, Start: 2048, End: 1050623, Bytes: 536870912},
		Root: Part{Path: "/dev/nvme0n1p2", Number: 2, Create: true, Format: true, Start: 1050624, End: 500118158, Bytes: 255522577920}}
	if !reflect.DeepEqual(pl.Layout, wantLayout) {
		t.Fatalf("layout\n got %+v\nwant %+v", pl.Layout, wantLayout)
	}
	wantSummary := []string{
		"Erase the whole disk Samsung SSD 980 (256 GB, /dev/nvme0n1). Everything on it is deleted.",
		"Create a 537 MB boot partition (EFI) and a 256 GB encrypted Rafiq partition.",
		"Encryption is on: you type a passphrase each time the computer starts.",
		"Language en_US.UTF-8, keyboard us, time zone Africa/Cairo.",
		`Your account: Ada Lovelace (ada) on the computer "ada-laptop".`,
		"Asks for your password at the login screen.",
		"Jarvis thinks on this computer with Qwen3 4B (2.6 GB download).",
		"About 243 GB stays free for your files.",
	}
	if !reflect.DeepEqual(pl.Public.Summary, wantSummary) {
		t.Fatalf("summary\n got %q\nwant %q", pl.Public.Summary, wantSummary)
	}
	var ids []string
	for _, s := range pl.Public.Steps {
		ids = append(ids, s.StepID)
	}
	if strings.Join(ids, ",") != "partition,encrypt,format,copy,configure,bootloader,model" {
		t.Fatalf("steps = %v", ids)
	}
	if !reflect.DeepEqual(pl.Public.DiskAfter, []DiskAfter{{"EFI boot", 536870912, false}, {"Rafiq", 255522577920, true}}) {
		t.Fatalf("diskAfter = %+v", pl.Public.DiskAfter)
	}
	if len(pl.Public.Warnings) != 2 || !strings.Contains(pl.Public.Warnings[1], "/dev/nvme0n1") || pl.Public.PlanID != "p1" {
		t.Fatalf("warnings = %q", pl.Public.Warnings)
	}
}

func TestPlanAlongsideNewESPExact(t *testing.T) {
	pl, err := MakePlan(choices("alongside", "/dev/loop1"), probe(windowsDisk()), "p2")
	if err != nil {
		t.Fatal(err)
	}
	l := pl.Layout
	if l.Shrink.Part.Path != "/dev/loop1p3" || l.Shrink.NewBytes != 27524071424 || l.Shrink.NewEnd != 53997567 || l.Shrink.Part.Start != 239616 {
		t.Fatalf("shrink = %+v", l.Shrink)
	}
	if l.ESP != (Part{Path: "/dev/loop1p5", Number: 5, Create: true, Format: true, Start: 53997568, End: 55046143, Bytes: 536870912}) {
		t.Fatalf("esp = %+v", l.ESP)
	}
	// Ends one sector before the Recovery partition, which is never touched.
	if l.Root != (Part{Path: "/dev/loop1p6", Number: 6, Create: true, Format: true, Start: 55046144, End: 132120575, Bytes: 39462109184}) {
		t.Fatalf("root = %+v", l.Root)
	}
	if !l.DualBoot || l.Wipe || l.FallbackBoot {
		t.Fatalf("flags = %+v", l)
	}
	if pl.Public.Summary[0] != "Shrink Windows from 68 GB to 28 GB, create 40 GB encrypted Rafiq." ||
		pl.Public.Summary[1] != "Create a new 537 MB boot partition (EFI)." {
		t.Fatalf("summary = %q", pl.Public.Summary[:2])
	}
	want := []DiskAfter{{"EFI boot", 104857600, false}, {"Microsoft reserved partition", 16777216, false}, {"Windows", 27524071424, false},
		{"EFI boot", 536870912, false}, {"Rafiq", 39462109184, true}, {"Recovery", 1073724928, false}}
	if !reflect.DeepEqual(pl.Public.DiskAfter, want) {
		t.Fatalf("diskAfter\n got %+v\nwant %+v", pl.Public.DiskAfter, want)
	}
	if pl.Public.Steps[0].Title != text.StepShrink || len(pl.Public.Warnings) != 3 {
		t.Fatalf("steps/warnings = %+v %q", pl.Public.Steps[0], pl.Public.Warnings)
	}
}

func TestPlanAlongsideReusesABigESP(t *testing.T) {
	d := windowsDisk()
	d.Partitions[0].SizeBytes = 314572800 // 300 MiB Windows ESP
	pl, err := MakePlan(choices("alongside", "/dev/loop1"), probe(d), "p")
	if err != nil {
		t.Fatal(err)
	}
	if pl.Layout.ESP != (Part{Path: "/dev/loop1p1", Number: 1, Bytes: 314572800}) {
		t.Fatalf("esp = %+v", pl.Layout.ESP)
	}
	if r := pl.Layout.Root; r.Number != 5 || r.Start != 53997568 || r.End != 132120575 {
		t.Fatalf("root = %+v", r)
	}
	if pl.Public.Summary[1] != "Use the existing boot partition /dev/loop1p1, shared with Windows." {
		t.Fatalf("summary = %q", pl.Public.Summary[1])
	}
}

// The Windows partition's start sector never moves, its new end still holds
// the shrunk file system, and Rafiq stays inside the space Windows gave
// up: checked for every size the slider can produce.
func TestPlanAlongsideNeverMovesWindowsAndNeverOverlaps(t *testing.T) {
	d := windowsDisk()
	win := d.Partitions[2]
	for j := int64(30_000_000_000); j <= win.SizeBytes; j += 377_000_017 {
		c := choices("alongside", "/dev/loop1")
		c.Disk.AlongsideSizeBytes = i64(j)
		c.Brain = Brain{Kind: "cloud"}
		pl, err := MakePlan(c, probe(d), "p")
		var r *Refusal
		if errors.As(err, &r) && r.Key == RefuseAlongsideSmall {
			continue
		}
		if err != nil {
			t.Fatalf("J=%d: %v", j, err)
		}
		l := pl.Layout
		if l.Shrink.Part.Start != win.Start {
			t.Fatalf("J=%d: Windows start moved", j)
		}
		if (l.Shrink.NewEnd-win.Start+1)*512 != l.Shrink.NewBytes {
			t.Fatalf("J=%d: the shrunk file system does not fill its partition exactly", j)
		}
		if l.Shrink.NewBytes < win.NTFS.MinSizeBytes {
			t.Fatalf("J=%d: Windows below its minimum", j)
		}
		for _, p := range []Part{l.ESP, l.Root} {
			if p.Create && (p.Start <= l.Shrink.NewEnd || p.End >= d.Partitions[3].Start || p.Start%2048 != 0) {
				t.Fatalf("J=%d: %+v overlaps or is unaligned", j, p)
			}
		}
	}
}

func refusal(t *testing.T, err error) string {
	t.Helper()
	var r *Refusal
	if !errors.As(err, &r) {
		t.Fatalf("err = %v, want a Refusal", err)
	}
	if !strings.HasPrefix(r.Error(), r.Key+": ") {
		t.Fatalf("message %q must start with the key", r.Error())
	}
	return r.Key
}

func TestPlanRefusals(t *testing.T) {
	small := emptyDisk()
	small.SizeBytes, small.LastUsable = 17179869184, 33554398
	mbr := windowsDisk()
	mbr.GPT = false
	noWin := windowsDisk()
	noWin.Partitions = noWin.Partitions[:2]
	with := func(f func(*NTFSState)) Disk {
		d := windowsDisk()
		st := *d.Partitions[2].NTFS
		f(&st)
		d.Partitions[2].NTFS = &st
		return d
	}
	bitlocker := windowsDisk()
	bitlocker.Partitions[2].FS = "BitLocker"
	bitlocker.Partitions[2].NTFS = &NTFSState{Bitlocker: true}

	cases := []struct {
		name string
		c    func() Choices
		p    ProbeResult
		key  string
	}{
		{"no uefi", func() Choices { return choices("erase", "/dev/nvme0n1") }, func() ProbeResult { p := probe(emptyDisk()); p.UEFI = false; return p }(), RefuseNoUEFI},
		{"erase disk too small", func() Choices { c := choices("erase", "/dev/nvme0n1"); c.Brain = Brain{Kind: "cloud"}; return c }, probe(small), RefuseDiskTooSmall},
		{"bitlocker", func() Choices { return choices("alongside", "/dev/loop1") }, probe(bitlocker), RefuseNTFSBitlocker},
		{"bitlocker wins over hibernated", func() Choices { return choices("alongside", "/dev/loop1") }, probe(with(func(s *NTFSState) { s.Bitlocker, s.Hibernated = true, true })), RefuseNTFSBitlocker},
		{"hibernated", func() Choices { return choices("alongside", "/dev/loop1") }, probe(with(func(s *NTFSState) { s.Hibernated = true })), RefuseNTFSHibernated},
		{"hibernated wins over dirty", func() Choices { return choices("alongside", "/dev/loop1") }, probe(with(func(s *NTFSState) { s.Hibernated, s.Dirty = true, true })), RefuseNTFSHibernated},
		{"dirty", func() Choices { return choices("alongside", "/dev/loop1") }, probe(with(func(s *NTFSState) { s.Dirty = true })), RefuseNTFSDirty},
		{"jarvis part too small", func() Choices {
			c := choices("alongside", "/dev/loop1")
			c.Disk.AlongsideSizeBytes = i64(20_000_000_000) // + new ESP needed
			return c
		}, probe(windowsDisk()), RefuseAlongsideSmall},
		{"windows would go below its minimum", func() Choices {
			c := choices("alongside", "/dev/loop1")
			c.Disk.AlongsideSizeBytes = i64(60_000_000_000)
			return c
		}, probe(windowsDisk()), RefuseAlongsideSmall},
		{"live medium", func() Choices { return choices("erase", "/dev/nvme0n1") },
			func() ProbeResult { p := probe(emptyDisk()); p.LiveDevice = str("/dev/nvme0n1"); return p }(), RefuseLiveMedium},
		{"no windows", func() Choices { return choices("alongside", "/dev/loop1") }, probe(noWin), RefuseAlongsideNoWin},
		{"mbr disk", func() Choices { return choices("alongside", "/dev/loop1") }, probe(mbr), RefuseAlongsideNoWin},
		{"manual no root", func() Choices {
			c := choices("manual", "/dev/loop1")
			c.Disk.Manual = []ManualEntry{{"/dev/loop1p1", "/boot/efi", false}}
			return c
		}, probe(windowsDisk()), RefuseManualNoRoot},
		{"manual no esp", func() Choices {
			c := choices("manual", "/dev/loop1")
			c.Disk.Manual = []ManualEntry{{"/dev/loop1p3", "/", true}}
			return c
		}, probe(windowsDisk()), RefuseManualNoESP},
		{"manual esp too small", func() Choices {
			c := choices("manual", "/dev/loop1")
			c.Disk.Manual = []ManualEntry{{"/dev/loop1p3", "/", true}, {"/dev/loop1p1", "/boot/efi", false}}
			return c
		}, probe(windowsDisk()), RefuseManualNoESP},
		{"manual root too small", func() Choices {
			d := choices("manual", "/dev/loop1")
			d.Disk.Manual = []ManualEntry{{"/dev/loop1p4", "/", true}, {"/dev/loop1p1", "/boot/efi", true}}
			return d
		}, func() ProbeResult { d := windowsDisk(); d.Partitions[0].SizeBytes = 314572800; return probe(d) }(), RefuseDiskTooSmall},
		{"model needs more RAM", func() Choices { c := choices("erase", "/dev/nvme0n1"); c.Brain.ModelID = "qwen3-8b"; return c },
			func() ProbeResult { p := probe(emptyDisk()); p.RAMBytes = 8_200_000_000; return p }(), RefuseModelDoesNotFit},
		{"model needs a GPU", func() Choices { c := choices("erase", "/dev/nvme0n1"); c.Brain.ModelID = "gpu-32b"; return c },
			func() ProbeResult { p := probe(emptyDisk()); p.RAMBytes = 64_000_000_000; return p }(), RefuseModelDoesNotFit},
		{"model does not fit on disk", func() Choices {
			c := choices("alongside", "/dev/loop1")
			c.Disk.AlongsideSizeBytes = i64(34_000_000_000) // 30 GiB + 1.8 GB: the 2.6 GB model does not fit
			c.Brain.ModelID = "small-4b"
			return c
		}, func() ProbeResult { d := windowsDisk(); d.Partitions[0].SizeBytes = 314572800; return probe(d) }(), RefuseModelDoesNotFit},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := MakePlan(tc.c(), tc.p, "p")
			if got := refusal(t, err); got != tc.key {
				t.Fatalf("key = %s, want %s (%v)", got, tc.key, err)
			}
		})
	}
}

func TestPlanInvalidInput(t *testing.T) {
	cases := map[string]func(*Choices){
		"unknown disk":          func(c *Choices) { c.Disk.Path = "/dev/sdz" },
		"bad mode":              func(c *Choices) { c.Disk.Mode = "wipe" },
		"size with erase":       func(c *Choices) { c.Disk.AlongsideSizeBytes = i64(1) },
		"bad username":          func(c *Choices) { c.User.Username = "Root;" },
		"reserved username":     func(c *Choices) { c.User.Username = "root" },
		"bad hostname":          func(c *Choices) { c.User.Hostname = "-x" },
		"gecos injection":       func(c *Choices) { c.User.FullName = "Ada:0:0" },
		"bad locale":            func(c *Choices) { c.Locale = "en_US" },
		"bad keyboard":          func(c *Choices) { c.Keyboard = "us;de" },
		"tz traversal":          func(c *Choices) { c.Timezone = "Europe/../../etc/shadow" },
		"unknown model":         func(c *Choices) { c.Brain.ModelID = "nope" },
		"lan url with password": func(c *Choices) { c.Brain = Brain{Kind: "lan", BaseURL: "http://u:p@host:11434", Model: "m"} },
		"lan url with query":    func(c *Choices) { c.Brain = Brain{Kind: "lan", BaseURL: "http://host:11434/?x=1", Model: "m"} },
		"lan url not http":      func(c *Choices) { c.Brain = Brain{Kind: "lan", BaseURL: "file:///etc/passwd", Model: "m"} },
		"manual root not formatted": func(c *Choices) {
			c.Disk.Mode = "manual"
			c.Disk.Manual = []ManualEntry{{"/dev/nvme0n1p9", "/", false}}
		},
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			c := choices("erase", "/dev/nvme0n1")
			mut(&c)
			_, err := MakePlan(c, probe(emptyDisk()), "p")
			var inv *InvalidError
			if !errors.As(err, &inv) {
				t.Fatalf("err = %v, want InvalidError", err)
			}
		})
	}
	// Manual-only invalid cases need a disk with partitions.
	for name, entries := range map[string][]ManualEntry{
		"root not formatted":   {{"/dev/loop1p3", "/", false}, {"/dev/loop1p1", "/boot/efi", false}},
		"same partition twice": {{"/dev/loop1p3", "/", true}, {"/dev/loop1p3", "/boot/efi", true}},
		"swap with encryption": {{"/dev/loop1p3", "/", true}, {"/dev/loop1p1", "/boot/efi", false}, {"/dev/loop1p4", "swap", true}},
		"bad mount":            {{"/dev/loop1p3", "/home", true}},
		"foreign partition":    {{"/dev/sda1", "/", true}},
	} {
		t.Run(name, func(t *testing.T) {
			c := choices("manual", "/dev/loop1")
			c.Disk.Manual = entries
			d := windowsDisk()
			d.Partitions[0].SizeBytes = 314572800
			_, err := MakePlan(c, probe(d), "p")
			var inv *InvalidError
			if !errors.As(err, &inv) {
				t.Fatalf("err = %v, want InvalidError", err)
			}
		})
	}
}

func TestPlanManualKeepsTheTableAndDetectsWindows(t *testing.T) {
	d := windowsDisk()
	d.Partitions[0].SizeBytes = 314572800
	c := choices("manual", "/dev/loop1")
	c.Encrypt = false
	c.Brain = Brain{Kind: "cloud"}
	c.Disk.Manual = []ManualEntry{{"/dev/loop1p3", "/", true}, {"/dev/loop1p1", "/boot/efi", false}}
	pl, err := MakePlan(c, probe(d), "p")
	if err != nil {
		t.Fatal(err)
	}
	l := pl.Layout
	if l.Wipe || l.Shrink != nil || l.Root.Create || l.ESP.Create || l.ESP.Format || !l.Root.Format || l.Root.Path != "/dev/loop1p3" {
		t.Fatalf("layout = %+v", l)
	}
	// The Recovery NTFS is not a basic-data partition: no other OS left.
	if l.DualBoot {
		t.Fatal("no Windows remains, so no dual boot")
	}
	if pl.Public.Steps[0].StepID != "format" {
		t.Fatalf("manual has no partition step: %+v", pl.Public.Steps)
	}
}

func TestPlanIsPure(t *testing.T) {
	c, p := choices("alongside", "/dev/loop1"), probe(windowsDisk())
	a, err1 := MakePlan(c, p, "same")
	b, err2 := MakePlan(c, p, "same")
	if err1 != nil || err2 != nil || !reflect.DeepEqual(a, b) {
		t.Fatal("same input must give the same plan")
	}
	if !reflect.DeepEqual(p, probe(windowsDisk())) {
		t.Fatal("MakePlan must not modify the probe")
	}
}

func TestModelFitsBoundaries(t *testing.T) {
	m := testCatalog[1].Model // minRamGB 8
	p := probe()
	p.RAMBytes = 7_700_000_000 // an "8 GB" laptop after firmware reservations
	if !ModelFits(m, 40_000_000_000, p) {
		t.Fatal("an 8 GB laptop must fit an 8 GB model")
	}
	p.RAMBytes = 7_100_000_000
	if ModelFits(m, 40_000_000_000, p) {
		t.Fatal("7.1 GB must not fit an 8 GB model")
	}
	p.RAMBytes = 64_000_000_000
	if ModelFits(m, MinRootBytes+m.SizeBytes-1, p) || !ModelFits(m, MinRootBytes+m.SizeBytes, p) {
		t.Fatal("disk boundary wrong")
	}
}

func TestPartPath(t *testing.T) {
	for in, want := range map[string]string{"/dev/sda": "/dev/sda2", "/dev/nvme0n1": "/dev/nvme0n1p2", "/dev/mmcblk0": "/dev/mmcblk0p2", "/dev/vdb": "/dev/vdb2"} {
		if got := PartPath(in, 2); got != want {
			t.Errorf("PartPath(%s) = %s", in, got)
		}
	}
}
