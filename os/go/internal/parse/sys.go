package parse

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Filesystem is one row of `df -B1 --output=target,size,used`.
type Filesystem struct {
	Mount     string
	SizeBytes int64
	UsedBytes int64
}

// DfArgs is the df argv whose output Df parses: real filesystems, sizes in
// bytes. The live session's root is an overlay, so overlay is kept.
var DfArgs = []string{"-B1", "--output=target,size,used", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "efivarfs"}

// Df parses `df -B1 --output=target,size,used`. The mount point is read
// from the left and the two numbers from the right, so a mount point with
// spaces ("/media/jarvis/USB DISK") survives.
func Df(out string) []Filesystem {
	var res []Filesystem
	for i, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 3 {
			continue // header or blank
		}
		size, err1 := strconv.ParseInt(f[len(f)-2], 10, 64)
		used, err2 := strconv.ParseInt(f[len(f)-1], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rest := strings.TrimRight(line, " \t\r")
		for k := 0; k < 2; k++ {
			rest = strings.TrimRight(rest[:strings.LastIndexAny(rest, " \t")], " \t")
		}
		mount := strings.TrimSpace(rest)
		res = append(res, Filesystem{Mount: mount, SizeBytes: size, UsedBytes: used})
	}
	return res
}

// DirSize is one row of `du -x -B1 -d 1 <root>`.
type DirSize struct {
	Path  string
	Bytes int64
}

// Du parses `du -B1` output ("<bytes>\t<path>"), drops the root's own total,
// and returns the top n entries by size, largest first.
func Du(out, root string, n int) []DirSize {
	root = strings.TrimSuffix(root, "/")
	var res []DirSize
	for _, line := range strings.Split(out, "\n") {
		num, path, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		b, err := strconv.ParseInt(strings.TrimSpace(num), 10, 64)
		if err != nil || strings.TrimSuffix(path, "/") == root {
			continue
		}
		res = append(res, DirSize{Path: path, Bytes: b})
	}
	sort.SliceStable(res, func(i, j int) bool { return res[i].Bytes > res[j].Bytes })
	if len(res) > n {
		res = res[:n]
	}
	return res
}

// Uptime parses /proc/uptime and returns whole seconds.
func Uptime(content string) (int64, error) {
	f := strings.Fields(content)
	if len(f) < 1 {
		return 0, fmt.Errorf("uptime: empty")
	}
	secs, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, fmt.Errorf("uptime: %w", err)
	}
	return int64(secs), nil
}

// Load1 parses the 1-minute load average from /proc/loadavg.
func Load1(content string) (float64, error) {
	f := strings.Fields(content)
	if len(f) < 1 {
		return 0, fmt.Errorf("loadavg: empty")
	}
	return strconv.ParseFloat(f[0], 64)
}

// MemStats is what sys.health reports from /proc/meminfo.
type MemStats struct {
	TotalBytes     int64
	AvailableBytes int64
	SwapTotalBytes int64
	SwapFreeBytes  int64
}

// UsedBytes is total minus available (what the kernel could not hand out
// without swapping), the number `free` shows as used.
func (m MemStats) UsedBytes() int64 { return m.TotalBytes - m.AvailableBytes }

// SwapUsedBytes is swap total minus swap free.
func (m MemStats) SwapUsedBytes() int64 { return m.SwapTotalBytes - m.SwapFreeBytes }

// MemInfo parses /proc/meminfo ("Key:   1234 kB").
func MemInfo(content string) (MemStats, error) {
	var m MemStats
	found := 0
	for _, line := range strings.Split(content, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && f[1] == "kB" {
			n *= 1024
		}
		switch k {
		case "MemTotal":
			m.TotalBytes = n
			found++
		case "MemAvailable":
			m.AvailableBytes = n
			found++
		case "SwapTotal":
			m.SwapTotalBytes = n
		case "SwapFree":
			m.SwapFreeBytes = n
		}
	}
	if found < 2 {
		return m, fmt.Errorf("meminfo: MemTotal/MemAvailable missing")
	}
	return m, nil
}
