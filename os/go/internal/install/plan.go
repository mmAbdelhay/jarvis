package install

import (
	"fmt"
	"sort"

	"github.com/mmAbdelhay/jarvis/os/go/internal/catalog"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/pkgtools"
)

// Sizes and policies. Bytes are decimal where a person reads them (GB on
// Review), binary where the disk wants alignment.
const (
	MiB = 1 << 20
	GiB = 1 << 30

	ESPSizeBytes         = 512 * MiB      // a new EFI system partition
	ESPReuseMinBytes     = 300_000_000    // an existing ESP this big is shared (design §5.2)
	MinRootBytes         = 32212254720    // 30 GiB: system, swap file, room to update (ProbeResult.minRootBytes)
	InstalledBytes       = 10_000_000_000 // what the copied system plus swap use, for "stays free"
	SwapFileBytes        = 2 * GiB        // design §5.2
	WindowsHeadroomBytes = 10_000_000_000 // Windows keeps this much free after shrinking
	alignBytes           = MiB
)

// GUIDs and sgdisk type codes.
const (
	espTypeGUID       = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
	basicDataTypeGUID = "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"
	codeESP           = "ef00"
	codeLUKS          = "8309"
	codeLinuxRoot     = "8304" // Linux x86-64 root (/)
)

// Part is one partition the install creates, formats or reuses.
type Part struct {
	Path       string
	Number     int
	Create     bool  // new GPT entry (Start..End)
	Format     bool  // mkfs it
	Start, End int64 // sectors, inclusive (Create only)
	Bytes      int64
}

// Shrink is the Windows partition and its new size.
type Shrink struct {
	Part     Partition
	NewBytes int64 // ntfsresize --size
	NewEnd   int64 // new last sector; Start never changes
}

// Layout is the exact disk work, computed once by MakePlan and executed
// verbatim. Execute never recomputes geometry.
type Layout struct {
	Mode         string
	Disk         string
	SectorBytes  int64
	Wipe         bool // erase: zap the partition table
	Shrink       *Shrink
	ESP          Part
	Root         Part
	Swap         *Part // manual swap partition, never with encryption
	Encrypt      bool
	DualBoot     bool // another OS stays: GRUB menu with a timeout, os-prober
	FallbackBoot bool // erase only: also install \EFI\BOOT\BOOTX64.EFI
}

// Planned is what the backend keeps for a planId: the public plan and
// everything Execute needs, all derived from one probe snapshot.
type Planned struct {
	Public  InstallPlan
	Choices Choices
	Disk    Disk // the probe's view of the target disk, compared again before writing
	Layout  Layout
	Model   *catalog.Model
	Online  bool
	// SecureBoot was on when probed; off means a note on the Done screen.
	SecureBoot bool
}

// MakePlan is a pure function: same choices and probe, same plan. It
// refuses (Refusal) what is unsafe or impossible and rejects (InvalidError)
// what is malformed. Nothing here touches a disk.
func MakePlan(c Choices, p ProbeResult, planID string) (Planned, error) {
	x := trFor(c)
	if !p.UEFI {
		return Planned{}, &Refusal{RefuseNoUEFI, x.t.NoUEFI}
	}
	if err := checkChoices(c); err != nil {
		return Planned{}, err
	}
	var disk *Disk
	for i := range p.Disks {
		if p.Disks[i].Path == c.Disk.Path {
			disk = &p.Disks[i]
		}
	}
	if disk == nil {
		return Planned{}, invalidf("%s is not a disk Rafiq can be installed on", c.Disk.Path)
	}
	if p.LiveDevice != nil && *p.LiveDevice == disk.Path {
		return Planned{}, &Refusal{RefuseLiveMedium, x.t.LiveMedium}
	}
	if disk.SectorBytes <= 0 || disk.LastUsable <= 0 {
		return Planned{}, invalidf("%s has no readable geometry", disk.Path)
	}
	if (c.Disk.AlongsideSizeBytes != nil) != (c.Disk.Mode == "alongside") || (len(c.Disk.Manual) > 0) != (c.Disk.Mode == "manual") {
		return Planned{}, invalidf("disk.alongsideSizeBytes is only for alongside and disk.manual only for manual")
	}
	var (
		lay Layout
		err error
	)
	switch c.Disk.Mode {
	case "erase":
		lay, err = planErase(x, *disk)
	case "alongside":
		lay, err = planAlongside(x, *disk, *c.Disk.AlongsideSizeBytes)
	case "manual":
		lay, err = planManual(x, *disk, c.Disk.Manual, c.Encrypt)
	default:
		return Planned{}, invalidf("disk.mode must be erase, alongside or manual")
	}
	if err != nil {
		return Planned{}, err
	}
	lay.Encrypt = c.Encrypt
	if lay.Root.Bytes < MinRootBytes {
		return Planned{}, &Refusal{RefuseDiskTooSmall, x.f(x.t.DiskTooSmall, lay.Root.Path, human(MinRootBytes))}
	}
	var model *catalog.Model
	if c.Brain.Kind == "local" {
		m, ok := catalog.Find(plainModels(p.Catalog), c.Brain.ModelID)
		if !ok {
			return Planned{}, invalidf("model %q is not in the catalog", c.Brain.ModelID)
		}
		if err := modelFits(x, m, lay.Root.Bytes, p); err != nil {
			return Planned{}, err
		}
		model = &m
	}
	pl := Planned{Choices: c, Disk: *disk, Layout: lay, Model: model, Online: p.Online, SecureBoot: p.SecureBoot}
	pl.Public = InstallPlan{
		PlanID:    planID,
		Summary:   summary(x, c, *disk, lay, model, p.Online),
		Steps:     steps(x, lay, model),
		DiskAfter: diskAfter(x, *disk, lay),
		Warnings:  warnings(x, *disk, lay),
	}
	return pl, nil
}

// ModelFits is the one rule for "this model fits this computer" (RAM 90 %
// of the decimal GB the catalog names, since firmware reserves some; VRAM
// the same; disk: MinRootBytes plus the model). The UI must hide models
// that fail it; Plan refuses them.
func ModelFits(m catalog.Model, rootBytes int64, p ProbeResult) bool {
	return modelFits(tr{l: i18n.EN, t: textEN}, m, rootBytes, p) == nil
}

func modelFits(x tr, m catalog.Model, rootBytes int64, p ProbeResult) error {
	if float64(p.RAMBytes) < m.MinRamGB*0.9e9 {
		return &Refusal{RefuseModelDoesNotFit, x.f(x.t.ModelTooBigRAM, m.DisplayName, int(m.MinRamGB), human(p.RAMBytes))}
	}
	if m.MinVramGB != nil {
		if p.GPU == nil || p.GPU.VRAMBytes == nil || float64(*p.GPU.VRAMBytes) < *m.MinVramGB*0.9e9 {
			return &Refusal{RefuseModelDoesNotFit, x.f(x.t.ModelNeedsGPU, m.DisplayName, int(*m.MinVramGB))}
		}
	}
	if rootBytes < MinRootBytes+m.SizeBytes {
		return &Refusal{RefuseModelDoesNotFit, x.f(x.t.ModelTooBigDisk, m.DisplayName, human(MinRootBytes+m.SizeBytes), human(rootBytes))}
	}
	return nil
}

func plainModels(in []ProbeModel) []catalog.Model {
	out := make([]catalog.Model, len(in))
	for i, m := range in {
		out[i] = m.Model
	}
	return out
}

func alignSectors(d Disk) int64 { return alignBytes / d.SectorBytes }

func alignUp(x, a int64) int64 { return (x + a - 1) / a * a }

func human(n int64) string { return pkgtools.HumanBytes(n) }

// PartPath names partition n of disk: "/dev/sda" → "/dev/sda2",
// "/dev/nvme0n1" → "/dev/nvme0n1p2" (a name ending in a digit takes "p").
func PartPath(disk string, n int) string {
	if c := disk[len(disk)-1]; c >= '0' && c <= '9' {
		return fmt.Sprintf("%sp%d", disk, n)
	}
	return fmt.Sprintf("%s%d", disk, n)
}

func planErase(x tr, d Disk) (Layout, error) {
	a := alignSectors(d)
	espSec := ESPSizeBytes / d.SectorBytes
	esp := Part{Number: 1, Create: true, Format: true, Start: a, End: a + espSec - 1}
	root := Part{Number: 2, Create: true, Format: true, Start: a + espSec, End: d.LastUsable}
	if root.End <= root.Start {
		return Layout{}, &Refusal{RefuseDiskTooSmall, x.f(x.t.DiskTooSmall, d.Path, human(MinRootBytes+ESPSizeBytes))}
	}
	esp.Path, root.Path = PartPath(d.Path, 1), PartPath(d.Path, 2)
	esp.Bytes = espSec * d.SectorBytes
	root.Bytes = (root.End - root.Start + 1) * d.SectorBytes
	if root.Bytes < MinRootBytes {
		return Layout{}, &Refusal{RefuseDiskTooSmall, x.f(x.t.DiskTooSmall, d.Path, human(MinRootBytes+ESPSizeBytes))}
	}
	return Layout{Mode: "erase", Disk: d.Path, SectorBytes: d.SectorBytes, Wipe: true, ESP: esp, Root: root, FallbackBoot: true}, nil
}

// windowsPartition is the largest Basic-data partition holding NTFS or
// BitLocker: the Windows system volume on a normal install.
func windowsPartition(d Disk) *Partition {
	var best *Partition
	for i := range d.Partitions {
		p := &d.Partitions[i]
		if p.TypeGUID == basicDataTypeGUID && (p.FS == "ntfs" || p.FS == "BitLocker") && (best == nil || p.SizeBytes > best.SizeBytes) {
			best = p
		}
	}
	return best
}

// reusableESP returns the disk's ESP when it is big enough to share.
func reusableESP(d Disk) *Partition {
	if d.ESP == nil {
		return nil
	}
	for i := range d.Partitions {
		p := &d.Partitions[i]
		if p.Path == *d.ESP && p.TypeGUID == espTypeGUID && p.FS == "vfat" && p.SizeBytes >= ESPReuseMinBytes {
			return p
		}
	}
	return nil
}

// freeNumbers returns the n lowest GPT entry numbers not in use.
func freeNumbers(d Disk, n int) []int {
	used := map[int]bool{}
	for _, p := range d.Partitions {
		used[p.Number] = true
	}
	var out []int
	for i := 1; len(out) < n && i <= 128; i++ {
		if !used[i] {
			out = append(out, i)
		}
	}
	return out
}

// planAlongside shrinks Windows' partition from its end only (its start
// sector never moves) and puts Rafiq in the space that frees.
func planAlongside(x tr, d Disk, jarvisBytes int64) (Layout, error) {
	win := windowsPartition(d)
	if !d.GPT || win == nil {
		return Layout{}, &Refusal{RefuseAlongsideNoWin, x.t.NoWindows}
	}
	if win.NTFS == nil {
		return Layout{}, &Refusal{RefuseNTFSDirty, x.t.Dirty}
	}
	switch {
	case win.NTFS.Bitlocker || win.FS == "BitLocker":
		return Layout{}, &Refusal{RefuseNTFSBitlocker, x.t.Bitlocker}
	case win.NTFS.Hibernated:
		return Layout{}, &Refusal{RefuseNTFSHibernated, x.t.Hibernated}
	case win.NTFS.Dirty:
		return Layout{}, &Refusal{RefuseNTFSDirty, x.t.Dirty}
	}
	esp := reusableESP(d)
	need := int64(MinRootBytes)
	if esp == nil {
		need += ESPSizeBytes
	}
	tooSmall := &Refusal{RefuseAlongsideSmall, x.f(x.t.AlongsideTooSmall, human(need), human(win.NTFS.MinSizeBytes))}
	newBytes := win.SizeBytes - jarvisBytes
	if jarvisBytes < need || newBytes < win.NTFS.MinSizeBytes || newBytes <= 0 {
		return Layout{}, tooSmall
	}
	s, a := d.SectorBytes, alignSectors(d)
	newEnd := alignUp(win.Start+(newBytes+s-1)/s, a) - 1
	limit := d.LastUsable
	for _, p := range d.Partitions {
		if p.Start > win.End && p.Start-1 < limit {
			limit = p.Start - 1
		}
	}
	regionStart := newEnd + 1
	regionEnd := regionStart + jarvisBytes/s - 1
	if regionEnd > limit {
		regionEnd = limit
	}
	if newEnd >= win.End || regionEnd <= regionStart || (regionEnd-regionStart+1)*s < need {
		return Layout{}, tooSmall
	}
	lay := Layout{Mode: "alongside", Disk: d.Path, SectorBytes: s, DualBoot: true,
		Shrink: &Shrink{Part: *win, NewBytes: newBytes, NewEnd: newEnd}}
	nums := freeNumbers(d, 2)
	if len(nums) < 2 {
		return Layout{}, tooSmall
	}
	rootStart := regionStart
	if esp != nil {
		lay.ESP = Part{Path: esp.Path, Number: esp.Number, Bytes: esp.SizeBytes}
	} else {
		espSec := ESPSizeBytes / s
		lay.ESP = Part{Path: PartPath(d.Path, nums[0]), Number: nums[0], Create: true, Format: true,
			Start: regionStart, End: regionStart + espSec - 1, Bytes: espSec * s}
		rootStart = regionStart + espSec
		nums = nums[1:]
	}
	lay.Root = Part{Path: PartPath(d.Path, nums[0]), Number: nums[0], Create: true, Format: true,
		Start: rootStart, End: regionEnd, Bytes: (regionEnd - rootStart + 1) * s}
	return lay, nil
}

// planManual uses existing partitions as the user assigned them; the
// partition table itself is never changed in manual mode.
func planManual(x tr, d Disk, entries []ManualEntry, encrypt bool) (Layout, error) {
	byPath := map[string]Partition{}
	for _, p := range d.Partitions {
		byPath[p.Path] = p
	}
	lay := Layout{Mode: "manual", Disk: d.Path, SectorBytes: d.SectorBytes}
	seenPart, seenMount := map[string]bool{}, map[string]bool{}
	var haveRoot, haveESP bool
	var espPart Partition
	for _, e := range entries {
		p, ok := byPath[e.Partition]
		if !ok {
			return Layout{}, invalidf("%s is not a partition of %s", e.Partition, d.Path)
		}
		if seenPart[e.Partition] || seenMount[e.Mount] {
			return Layout{}, invalidf("each partition and each mount point may be used once")
		}
		seenPart[e.Partition], seenMount[e.Mount] = true, true
		part := Part{Path: p.Path, Number: p.Number, Format: e.Format, Bytes: p.SizeBytes}
		switch e.Mount {
		case "/":
			if !e.Format {
				return Layout{}, invalidf("the Rafiq partition (/) must be formatted")
			}
			lay.Root, haveRoot = part, true
		case "/boot/efi":
			lay.ESP, haveESP, espPart = part, true, p
		case "swap":
			if encrypt {
				return Layout{}, invalidf("a swap partition cannot be used with encryption; Rafiq uses an encrypted swap file instead")
			}
			if !e.Format && p.FS != "swap" {
				return Layout{}, invalidf("%s is not a swap partition; tick Format to make it one", p.Path)
			}
			sw := part
			lay.Swap = &sw
		default:
			return Layout{}, invalidf("mount must be /, /boot/efi or swap")
		}
	}
	if !haveRoot {
		return Layout{}, &Refusal{RefuseManualNoRoot, x.t.ManualNoRoot}
	}
	if !haveESP {
		return Layout{}, &Refusal{RefuseManualNoESP, x.t.ManualNoESP}
	}
	if espPart.TypeGUID != espTypeGUID || espPart.SizeBytes < ESPReuseMinBytes || (!lay.ESP.Format && espPart.FS != "vfat") {
		return Layout{}, &Refusal{RefuseManualNoESP, x.f(x.t.ManualSmallESP, espPart.Path, human(ESPReuseMinBytes))}
	}
	for _, p := range d.Partitions {
		if !seenPart[p.Path] && p.TypeGUID == basicDataTypeGUID && (p.FS == "ntfs" || p.FS == "BitLocker") {
			lay.DualBoot = true
		}
	}
	return lay, nil
}

func summary(x tr, c Choices, d Disk, lay Layout, model *catalog.Model, online bool) []string {
	enc := ""
	if lay.Encrypt {
		enc = x.t.Encrypted
	}
	var out []string
	switch lay.Mode {
	case "erase":
		name := d.Model
		if name == "" {
			name = d.Path
		}
		out = append(out, x.f(x.t.EraseDisk, name, human(d.SizeBytes), d.Path),
			x.f(x.t.EraseCreate, human(lay.ESP.Bytes), human(lay.Root.Bytes), enc))
	case "alongside":
		out = append(out, x.f(x.t.AlongsideShrink, human(lay.Shrink.Part.SizeBytes), human(lay.Shrink.NewBytes), human(lay.Root.Bytes+espIfNew(lay)), enc))
		if lay.ESP.Create {
			out = append(out, x.f(x.t.ESPCreate, human(lay.ESP.Bytes)))
		} else {
			out = append(out, x.f(x.t.ESPReuse, lay.ESP.Path))
		}
	case "manual":
		out = append(out, x.f(x.t.ManualRoot, lay.Root.Path, human(lay.Root.Bytes), enc))
		if lay.ESP.Format {
			out = append(out, x.f(x.t.ManualESPFormat, lay.ESP.Path))
		} else {
			out = append(out, x.f(x.t.ManualESPKeep, lay.ESP.Path))
		}
		if lay.Swap != nil {
			if lay.Swap.Format {
				out = append(out, x.f(x.t.ManualSwapFormat, lay.Swap.Path))
			} else {
				out = append(out, x.f(x.t.ManualSwapKeep, lay.Swap.Path))
			}
		}
	}
	if lay.Encrypt {
		out = append(out, x.t.EncryptOn)
	} else {
		out = append(out, x.t.EncryptOff)
	}
	out = append(out, x.f(x.t.Regional, c.Locale, c.Keyboard, c.Timezone),
		x.f(x.t.Account, c.User.FullName, c.User.Username, c.User.Hostname))
	if c.User.Autologin {
		out = append(out, x.t.LoginAuto)
	} else {
		out = append(out, x.t.LoginPassword)
	}
	free := lay.Root.Bytes - InstalledBytes
	switch c.Brain.Kind {
	case "local":
		if online {
			out = append(out, x.f(x.t.BrainLocal, model.DisplayName, human(model.SizeBytes)))
		} else {
			out = append(out, x.f(x.t.BrainLocalLater, model.DisplayName, human(model.SizeBytes)))
		}
		free -= model.SizeBytes
	case "cloud":
		out = append(out, x.t.BrainCloud)
	case "lan":
		base, _ := normalizeBaseURL(c.Brain.BaseURL)
		out = append(out, x.f(x.t.BrainLAN, c.Brain.Model, base))
	}
	return append(out, x.f(x.t.FreeAfter, human(free)))
}

func espIfNew(lay Layout) int64 {
	if lay.ESP.Create {
		return lay.ESP.Bytes
	}
	return 0
}

func steps(x tr, lay Layout, model *catalog.Model) []Step {
	var out []Step
	switch lay.Mode {
	case "erase":
		out = append(out, Step{"partition", x.t.StepPartition})
	case "alongside":
		out = append(out, Step{"partition", x.t.StepShrink})
	}
	if lay.Encrypt {
		out = append(out, Step{"encrypt", x.t.StepEncrypt})
	}
	out = append(out, Step{"format", x.t.StepFormat}, Step{"copy", x.t.StepCopy},
		Step{"configure", x.t.StepConfigure}, Step{"bootloader", x.t.StepBootloader})
	if model != nil {
		out = append(out, Step{"model", x.t.StepModel})
	}
	return out
}

func warnings(x tr, d Disk, lay Layout) []string {
	out := []string{x.t.NoUndo}
	switch lay.Mode {
	case "erase":
		out = append(out, x.f(x.t.EraseAll, d.Path))
	case "alongside":
		out = append(out, x.t.AlongsideBackup, x.t.Chkdsk)
	}
	if d.Removable {
		out = append(out, x.f(x.t.Removable, d.Path))
	}
	return out
}

// diskAfter lists the partitions in disk order as they will be after install.
func diskAfter(x tr, d Disk, lay Layout) []DiskAfter {
	type row struct {
		start int64
		DiskAfter
	}
	var rows []row
	label := func(p Partition) string {
		switch {
		case p.TypeGUID == espTypeGUID:
			return x.t.LabelESP
		case p.Label != "":
			return p.Label
		case p.Name != "":
			return p.Name
		}
		return x.f(x.t.LabelPartition, p.Number)
	}
	if lay.Mode != "erase" {
		for _, p := range d.Partitions {
			r := row{p.Start, DiskAfter{Label: label(p), SizeBytes: p.SizeBytes}}
			switch {
			case lay.Shrink != nil && p.Path == lay.Shrink.Part.Path:
				r.Label, r.SizeBytes = x.t.LabelWindows, lay.Shrink.NewBytes
			case p.Path == lay.Root.Path:
				r.Label, r.Encrypted = x.t.LabelJarvis, lay.Encrypt
			case p.Path == lay.ESP.Path:
				r.Label = x.t.LabelESP
			case lay.Swap != nil && p.Path == lay.Swap.Path:
				r.Label = x.t.LabelSwap
			}
			rows = append(rows, r)
		}
	}
	if lay.ESP.Create {
		rows = append(rows, row{lay.ESP.Start, DiskAfter{x.t.LabelESP, lay.ESP.Bytes, false}})
	}
	if lay.Root.Create {
		rows = append(rows, row{lay.Root.Start, DiskAfter{x.t.LabelJarvis, lay.Root.Bytes, lay.Encrypt}})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].start < rows[j].start })
	out := make([]DiskAfter, len(rows))
	for i, r := range rows {
		out[i] = r.DiskAfter
	}
	return out
}
