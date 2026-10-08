package parse

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// BlockDevice is one row of
// `lsblk -J -l -b -o PATH,PKNAME,TYPE,SIZE,MODEL,RM,RO,LOG-SEC`.
// -l (list) keeps the output flat with PKNAME naming the parent, so the
// shape is the same with or without udev (nested "children" only appear in
// tree mode). Without udev lsblk cannot fill FSTYPE/PARTTYPE/PTTYPE, which
// is why the installer reads those from `blkid -p` instead.
type BlockDevice struct {
	Path   string
	Parent string // kernel name of the parent ("nvme0n1"), "" for a disk
	Type   string // "disk", "part", "loop", "rom", ...
	Size   int64
	Model  string
	RM, RO bool
	LogSec int64
}

// Lsblk parses the JSON above. Old util-linux printed rm/ro as "0"/"1" and
// sizes as strings; both shapes are accepted.
func Lsblk(out []byte) ([]BlockDevice, error) {
	var doc struct {
		Devices []struct {
			Path   string   `json:"path"`
			PKName *string  `json:"pkname"`
			Type   string   `json:"type"`
			Size   flexInt  `json:"size"`
			Model  *string  `json:"model"`
			RM     flexBool `json:"rm"`
			RO     flexBool `json:"ro"`
			LogSec flexInt  `json:"log-sec"`
		} `json:"blockdevices"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	res := make([]BlockDevice, 0, len(doc.Devices))
	for _, d := range doc.Devices {
		bd := BlockDevice{Path: d.Path, Type: d.Type, Size: int64(d.Size), RM: bool(d.RM), RO: bool(d.RO), LogSec: int64(d.LogSec)}
		if d.PKName != nil {
			bd.Parent = *d.PKName
		}
		if d.Model != nil {
			bd.Model = strings.TrimSpace(*d.Model)
		}
		res = append(res, bd)
	}
	return res, nil
}

type flexInt int64

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "null" || s == "" {
		*f = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	*f = flexInt(n)
	return err
}

type flexBool bool

func (f *flexBool) UnmarshalJSON(b []byte) error {
	switch strings.Trim(string(b), `"`) {
	case "true", "1":
		*f = true
	default:
		*f = false
	}
	return nil
}

// BlkidExport parses `blkid -p -o export <dev>`: KEY=value lines, where
// blkid escapes spaces and other specials with a backslash
// ("PART_ENTRY_NAME=Basic\ data\ partition").
func BlkidExport(out string) map[string]string {
	res := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok || k == "" {
			continue
		}
		var b strings.Builder
		for i := 0; i < len(v); i++ {
			if v[i] == '\\' && i+1 < len(v) {
				i++
			}
			b.WriteByte(v[i])
		}
		res[k] = b.String()
	}
	return res
}

// GPTPartition is one row of `sgdisk -p`'s partition table.
type GPTPartition struct {
	Number     int
	Start, End int64 // sectors, inclusive
	Code       string
}

// GPTGeometry is what `sgdisk -p <disk>` says about a disk.
type GPTGeometry struct {
	TotalSectors int64
	SectorBytes  int64 // logical
	FirstUsable  int64
	LastUsable   int64
	AlignSectors int64
	NewTable     bool // no valid GPT on disk: sgdisk is showing a fresh in-memory one
	ConvertedMBR bool // sgdisk found an MBR table and converted it in memory
	Partitions   []GPTPartition
}

var (
	sgDiskRe   = regexp.MustCompile(`^Disk \S+: (\d+) sectors`)
	sgSectorRe = regexp.MustCompile(`^Sector size \(logical/physical\): (\d+)/\d+ bytes`)
	sgUsableRe = regexp.MustCompile(`^First usable sector is (\d+), last usable sector is (\d+)`)
	sgAlignRe  = regexp.MustCompile(`^Partitions will be aligned on (\d+)-sector boundaries`)
	sgRowRe    = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+([0-9A-F]{4})\b`)
)

// SgdiskPrint parses `sgdisk -p <disk>`.
func SgdiskPrint(out string) (GPTGeometry, error) {
	var g GPTGeometry
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "Creating new GPT entries"):
			g.NewTable = true
		case strings.Contains(line, "converting MBR to GPT"):
			g.ConvertedMBR = true
		}
		if m := sgDiskRe.FindStringSubmatch(line); m != nil {
			g.TotalSectors, _ = strconv.ParseInt(m[1], 10, 64)
		} else if m := sgSectorRe.FindStringSubmatch(line); m != nil {
			g.SectorBytes, _ = strconv.ParseInt(m[1], 10, 64)
		} else if m := sgUsableRe.FindStringSubmatch(line); m != nil {
			g.FirstUsable, _ = strconv.ParseInt(m[1], 10, 64)
			g.LastUsable, _ = strconv.ParseInt(m[2], 10, 64)
		} else if m := sgAlignRe.FindStringSubmatch(line); m != nil {
			g.AlignSectors, _ = strconv.ParseInt(m[1], 10, 64)
		} else if m := sgRowRe.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			s, _ := strconv.ParseInt(m[2], 10, 64)
			e, _ := strconv.ParseInt(m[3], 10, 64)
			g.Partitions = append(g.Partitions, GPTPartition{Number: n, Start: s, End: e, Code: m[4]})
		}
	}
	if g.TotalSectors == 0 || g.SectorBytes == 0 || g.LastUsable == 0 {
		return g, fmt.Errorf("sgdisk -p: no disk geometry in output")
	}
	return g, nil
}

// NTFSInfo is what `ntfsresize --info --no-progress-bar <part>` reports.
type NTFSInfo struct {
	VolumeBytes int64 // "Current volume size"
	MinBytes    int64 // "You might resize at N bytes"; 0 when not reported
	UsedBytes   int64 // "Space in use : N MB", decimal MB
	Dirty       bool  // scheduled for chkdsk or shut down uncleanly
	Hibernated  bool  // only when ntfsresize itself says so (it does not on --info)
	NotNTFS     bool  // no NTFS signature (e.g. BitLocker)
}

var (
	ntfsVolRe  = regexp.MustCompile(`Current volume size\s*:\s*(\d+) bytes`)
	ntfsMinRe  = regexp.MustCompile(`You might resize at (\d+) bytes`)
	ntfsUsedRe = regexp.MustCompile(`Space in use\s*:\s*(\d+) MB`)
)

// NTFSResize parses ntfsresize --info output (stdout and stderr together).
func NTFSResize(out string) NTFSInfo {
	var n NTFSInfo
	if m := ntfsVolRe.FindStringSubmatch(out); m != nil {
		n.VolumeBytes, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := ntfsMinRe.FindStringSubmatch(out); m != nil {
		n.MinBytes, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := ntfsUsedRe.FindStringSubmatch(out); m != nil {
		mb, _ := strconv.ParseInt(m[1], 10, 64)
		n.UsedBytes = mb * 1_000_000
	}
	n.Dirty = strings.Contains(out, "scheduled for check") || strings.Contains(out, "shutdown uncleanly") ||
		strings.Contains(out, "unclean file system")
	n.Hibernated = strings.Contains(out, "hibernated") || strings.Contains(out, "Metadata kept in Windows cache")
	n.NotNTFS = strings.Contains(out, "NTFS signature is missing")
	return n
}

// EFIBool reads a boolean EFI variable from efivarfs: 4 attribute bytes,
// then the value byte (SecureBoot-8be4df61-...: 1 = enabled).
func EFIBool(b []byte) (bool, error) {
	if len(b) < 5 {
		return false, fmt.Errorf("efivar: %d bytes, want at least 5", len(b))
	}
	return b[4] == 1, nil
}

// Mount is one line of /proc/mounts.
type Mount struct {
	Source, Target, FSType string
}

// ProcMounts parses /proc/mounts. The kernel escapes space, tab, newline
// and backslash as octal (\040).
func ProcMounts(content string) []Mount {
	var res []Mount
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		res = append(res, Mount{Source: unOctal(f[0]), Target: unOctal(f[1]), FSType: f[2]})
	}
	return res
}

// ProcSwaps returns the swap devices/files in /proc/swaps.
func ProcSwaps(content string) []string {
	var res []string
	for i, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) == 0 {
			continue
		}
		res = append(res, unOctal(f[0]))
	}
	return res
}

func unOctal(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// EFIBootEntry is one "BootXXXX" line of `efibootmgr`.
type EFIBootEntry struct {
	Num   string // "0003"
	Label string
}

var efiBootRe = regexp.MustCompile(`^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$`)

// EFIBootMgr parses `efibootmgr` output. efibootmgr 18 separates the label
// from the device path with a tab; older versions print only the label.
func EFIBootMgr(out string) []EFIBootEntry {
	var res []EFIBootEntry
	for _, line := range strings.Split(out, "\n") {
		m := efiBootRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		label, _, _ := strings.Cut(m[2], "\t")
		res = append(res, EFIBootEntry{Num: m[1], Label: strings.TrimSpace(label)})
	}
	return res
}

// PasswdEntry is one line of /etc/passwd.
type PasswdEntry struct {
	Name     string
	UID, GID int
	Home     string
}

// Passwd parses /etc/passwd.
func Passwd(content string) []PasswdEntry {
	var res []PasswdEntry
	for _, line := range strings.Split(content, "\n") {
		f := strings.Split(line, ":")
		if len(f) < 7 {
			continue
		}
		uid, err1 := strconv.Atoi(f[2])
		gid, err2 := strconv.Atoi(f[3])
		if err1 != nil || err2 != nil {
			continue
		}
		res = append(res, PasswdEntry{Name: f[0], UID: uid, GID: gid, Home: f[5]})
	}
	return res
}
