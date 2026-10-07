package install

import (
	"context"
	"io"
	"net/http"
	"path"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/catalog"
	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
)

// Paths the probe reads.
const (
	LiveMedium    = "/run/live/medium"
	RunDir        = "/run/jarvis-installer"
	ntfsProbeDir  = RunDir + "/ntfs-probe"
	secureBootVar = "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"
	// DefaultGeoURL answers <TimeZone>Area/City</TimeZone> for the caller's
	// IP (Ubuntu's installer uses it). Only asked when online.
	DefaultGeoURL = "https://geoip.ubuntu.com/lookup"
)

const probeTimeout = 2 * time.Minute

// ProbeDeps are Probe's side effects.
type ProbeDeps struct {
	Run       execx.Runner
	Files     files.FS
	HTTP      *http.Client // nil: no time zone lookup
	GeoURL    string       // "" means DefaultGeoURL
	AllowLoop bool         // offer loop devices (tests, the loop-device integration test)
	// Only, when set, limits the probe to these disks (the loop-device test
	// must not touch other loop devices on the machine).
	Only []string
}

func (d ProbeDeps) run(ctx context.Context, name string, args ...string) (execx.Result, error) {
	return d.Run.Run(ctx, execx.Cmd{Name: name, Args: args, Timeout: probeTimeout})
}

// Probe reads the machine. It never writes to a disk: the only mount is a
// read-only one of an NTFS volume, to look for hiberfil.sys. Everything but
// the disk list degrades to "unknown" rather than failing.
func Probe(ctx context.Context, d ProbeDeps) (ProbeResult, error) {
	p := ProbeResult{UEFI: d.Files.Exists("/sys/firmware/efi"), Disks: []Disk{}, Catalog: []ProbeModel{}, MinRootBytes: MinRootBytes}
	if b, err := d.Files.ReadFile(secureBootVar); err == nil {
		p.SecureBoot, _ = parse.EFIBool(b)
	}
	if b, err := d.Files.ReadFile("/proc/meminfo"); err == nil {
		if m, err := parse.MemInfo(string(b)); err == nil {
			p.RAMBytes = m.TotalBytes
		}
	}
	p.GPU = d.gpu(ctx)
	if res, err := d.run(ctx, "nmcli", "-t", "networking", "connectivity", "check"); err == nil && res.ExitCode == 0 {
		p.Online = strings.TrimSpace(string(res.Stdout)) == "full"
	}
	if p.Online {
		p.GeoTimezone = d.geoTimezone(ctx)
	}
	disks, live, err := d.disks(ctx)
	if err != nil {
		return p, err
	}
	p.Disks, p.LiveDevice = disks, live
	if ms, err := catalog.Load(d.Files, catalog.Path); err == nil {
		// Fits is judged against the largest disk offered (the most room
		// any layout could give); Plan re-checks against the real layout.
		var biggest int64
		for _, dk := range disks {
			if dk.SizeBytes > biggest {
				biggest = dk.SizeBytes
			}
		}
		for _, m := range ms {
			p.Catalog = append(p.Catalog, ProbeModel{Model: m, Fits: ModelFits(m, biggest, p)})
		}
	}
	return p, nil
}

func (d ProbeDeps) gpu(ctx context.Context) *GPU {
	res, err := d.run(ctx, "lspci", "-k")
	if err != nil || res.ExitCode != 0 {
		return nil
	}
	for _, dev := range parse.LspciK(string(res.Stdout)) {
		class, name, ok := strings.Cut(dev.Name, ": ")
		if !ok || !(strings.HasPrefix(class, "VGA compatible controller") || strings.HasPrefix(class, "3D controller") || strings.HasPrefix(class, "Display controller")) {
			continue
		}
		g := &GPU{Name: name}
		if m, _ := d.Files.Glob("/sys/class/drm/card*/device/mem_info_vram_total"); len(m) > 0 {
			if b, err := d.Files.ReadFile(m[0]); err == nil {
				if n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && n > 0 {
					g.VRAMBytes = &n
				}
			}
		}
		return g
	}
	return nil
}

var geoTZRe = regexp.MustCompile(`<TimeZone>([^<]{1,64})</TimeZone>`)

func (d ProbeDeps) geoTimezone(ctx context.Context) *string {
	if d.HTTP == nil {
		return nil
	}
	u := d.GeoURL
	if u == "" {
		u = DefaultGeoURL
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	resp, err := d.HTTP.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	m := geoTZRe.FindSubmatch(b)
	if m == nil {
		return nil
	}
	tz := string(m[1])
	if !tzRe.MatchString(tz) || strings.Contains(tz, "..") || !d.Files.Exists("/usr/share/zoneinfo/"+tz) {
		return nil
	}
	return &tz
}

// liveDisk returns the path of the disk the live system booted from.
func (d ProbeDeps) liveDisk(devs []parse.BlockDevice) string {
	b, err := d.Files.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	var src string
	for _, m := range parse.ProcMounts(string(b)) {
		if m.Target == LiveMedium {
			src = m.Source
		}
	}
	for _, dev := range devs {
		if dev.Path == src {
			if dev.Parent == "" {
				return dev.Path
			}
			return "/dev/" + dev.Parent
		}
	}
	return ""
}

// disks lists installable disks. The live medium's disk is listed too (the
// UI shows it greyed out) and reported as live; Plan refuses it.
func (d ProbeDeps) disks(ctx context.Context) ([]Disk, *string, error) {
	res, err := d.run(ctx, "lsblk", "-J", "-l", "-b", "-o", "PATH,PKNAME,TYPE,SIZE,MODEL,RM,RO,LOG-SEC")
	if err != nil {
		return nil, nil, err
	}
	devs, err := parse.Lsblk(res.Stdout)
	if err != nil {
		return nil, nil, err
	}
	live := d.liveDisk(devs)
	var livePtr *string
	if live != "" {
		livePtr = &live
	}
	out := []Disk{}
	for _, dev := range devs {
		name := path.Base(dev.Path)
		installable := dev.Type == "disk" || (d.AllowLoop && dev.Type == "loop")
		if len(d.Only) > 0 && !slices.Contains(d.Only, dev.Path) {
			continue
		}
		if !installable || dev.RO || dev.Size < 1_000_000_000 ||
			strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "sr") {
			continue
		}
		var parts []parse.BlockDevice
		for _, c := range devs {
			if c.Type == "part" && c.Parent == name {
				parts = append(parts, c)
			}
		}
		out = append(out, d.disk(ctx, dev, parts))
	}
	return out, livePtr, nil
}

func (d ProbeDeps) disk(ctx context.Context, dev parse.BlockDevice, parts []parse.BlockDevice) Disk {
	disk := Disk{Path: dev.Path, Model: dev.Model, SizeBytes: dev.Size, Removable: dev.RM, Partitions: []Partition{}, SectorBytes: dev.LogSec}
	bres, _ := d.run(ctx, "blkid", "-p", "-o", "export", dev.Path)
	pttype := parse.BlkidExport(string(bres.Stdout))["PTTYPE"]
	if sres, err := d.run(ctx, "sgdisk", "-p", dev.Path); err == nil {
		if g, err := parse.SgdiskPrint(string(sres.Stdout)); err == nil {
			disk.SectorBytes, disk.FirstUsable, disk.LastUsable = g.SectorBytes, g.FirstUsable, g.LastUsable
			disk.GPT = pttype == "gpt" && !g.NewTable && !g.ConvertedMBR
		}
	}
	mounts := map[string]string{}
	if b, err := d.Files.ReadFile("/proc/mounts"); err == nil {
		for _, m := range parse.ProcMounts(string(b)) {
			mounts[m.Source] = m.Target
		}
	}
	for _, pd := range parts {
		disk.Partitions = append(disk.Partitions, d.partition(ctx, pd, mounts[pd.Path]))
	}
	sort.SliceStable(disk.Partitions, func(i, j int) bool { return disk.Partitions[i].Start < disk.Partitions[j].Start })
	var esp *Partition
	for i := range disk.Partitions {
		p := &disk.Partitions[i]
		if p.TypeGUID == espTypeGUID && p.FS == "vfat" && (esp == nil || p.SizeBytes > esp.SizeBytes) {
			esp = p
		}
	}
	if esp != nil {
		disk.ESP = &esp.Path
	}
	return disk
}

func (d ProbeDeps) partition(ctx context.Context, pd parse.BlockDevice, mountedAt string) Partition {
	res, _ := d.run(ctx, "blkid", "-p", "-o", "export", pd.Path)
	kv := parse.BlkidExport(string(res.Stdout))
	p := Partition{Path: pd.Path, FS: kv["TYPE"], Label: kv["LABEL"], SizeBytes: pd.Size,
		TypeGUID: strings.ToLower(kv["PART_ENTRY_TYPE"]), UniqueGUID: strings.ToLower(kv["PART_ENTRY_UUID"]), Name: kv["PART_ENTRY_NAME"]}
	p.Number, _ = strconv.Atoi(kv["PART_ENTRY_NUMBER"])
	off, _ := strconv.ParseInt(kv["PART_ENTRY_OFFSET"], 10, 64)
	n, _ := strconv.ParseInt(kv["PART_ENTRY_SIZE"], 10, 64)
	p.Start, p.End = off, off+n-1
	if f := strings.TrimPrefix(kv["PART_ENTRY_FLAGS"], "0x"); f != "" {
		p.Flags, _ = strconv.ParseUint(f, 16, 64)
	}
	if p.FS == "BitLocker" || d.bitlockerSignature(pd.Path) {
		p.FS = "BitLocker"
		p.NTFS = &NTFSState{Bitlocker: true, MinSizeBytes: p.SizeBytes}
		return p
	}
	if p.FS == "ntfs" {
		p.NTFS, p.UsedBytes = d.ntfs(ctx, p, mountedAt)
	}
	return p
}

// bitlockerSignature reads the volume boot record: BitLocker writes
// "-FVE-FS-" at offset 3 where NTFS has "NTFS    ".
func (d ProbeDeps) bitlockerSignature(dev string) bool {
	b, err := d.Files.ReadHead(dev, 11)
	return err == nil && len(b) == 11 && string(b[3:11]) == "-FVE-FS-"
}

func (d ProbeDeps) ntfs(ctx context.Context, p Partition, mountedAt string) (*NTFSState, *int64) {
	res, _ := d.run(ctx, "ntfsresize", "--info", "--no-progress-bar", p.Path)
	info := parse.NTFSResize(string(res.Stdout) + string(res.Stderr))
	st := &NTFSState{Dirty: info.Dirty, Hibernated: info.Hibernated || d.hibernated(ctx, p.Path, mountedAt), MinSizeBytes: p.SizeBytes}
	if info.MinBytes > 0 {
		min := alignUp(info.MinBytes+WindowsHeadroomBytes, 1_000_000)
		if min < p.SizeBytes {
			st.MinSizeBytes = min
		}
	}
	var used *int64
	if info.UsedBytes > 0 {
		used = &info.UsedBytes
	}
	return st, used
}

// hibernated looks for a hibernation image ("hibr" at the start of
// hiberfil.sys: real hibernation or Fast Startup). ntfsresize --info cannot
// tell (libntfs-3g checks only on read-write mounts), so the volume is
// mounted read-only with the kernel ntfs3 driver (Debian's kernel ships it;
// no FUSE fallback: a stuck FUSE mount cannot be killed). If it cannot be
// checked, the answer is "hibernated": shrinking is refused rather than
// risk a Windows that resumes onto a changed disk.
func (d ProbeDeps) hibernated(ctx context.Context, dev, mountedAt string) bool {
	dir := mountedAt
	if dir == "" {
		if err := d.Files.MkdirAll(ntfsProbeDir, 0o700); err != nil {
			return true
		}
		res, err := d.run(ctx, "mount", "-t", "ntfs3", "-o", "ro,nosuid,nodev,noexec", dev, ntfsProbeDir)
		if err != nil || res.ExitCode != 0 {
			return true
		}
		defer d.run(context.WithoutCancel(ctx), "umount", ntfsProbeDir)
		dir = ntfsProbeDir
	}
	head, err := d.Files.ReadHead(dir+"/hiberfil.sys", 4)
	return err == nil && strings.EqualFold(string(head), "hibr")
}
