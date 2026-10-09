package install

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
)

// Fixed paths of the install.
const (
	Target        = "/target"
	MapperPath    = "/dev/mapper/" + mapperName
	Squashfs      = LiveMedium + "/live/filesystem.squashfs"
	squashfsSize  = LiveMedium + "/live/filesystem.size"
	gptBackup     = RunDir + "/gpt-backup.bin"
	targetGPTCopy = Target + "/var/log/jarvis-installer-gpt-backup.bin"
)

// livePackages are removed from the copied system (design §5.2 step 4).
var livePackages = []string{"live-boot", "live-boot-initramfs-tools", "live-config", "live-config-systemd", "live-tools",
	"jarvis-installer", "jarvis-installer-backend"}

// userGroups are the new user's supplementary groups (design §5.2 step 5).
const userGroups = "sudo,jarvis-admins,netdev,systemd-journal"

// Events is how Execute reports (the D-Bus signals of contracts §1).
type Events interface {
	Progress(stepID string, percent int, detail string)
	ModelProgress(percent int, detail string)
	Finished(ok bool, errorStep, message string)
}

// Gate lets Cancel race safely with the start of the first destructive
// command: Commit returns false when the install was cancelled, and after
// Commit returns true Cancel is refused.
type Gate struct {
	mu        sync.Mutex
	cancelled bool
	committed bool
}

// Cancel stops the install if nothing has been written yet.
func (g *Gate) Cancel() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.committed {
		return false
	}
	g.cancelled = true
	return true
}

// Commit marks the point of no return.
func (g *Gate) Commit() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cancelled {
		return false
	}
	g.committed = true
	return true
}

// Deps are Execute's side effects.
type Deps struct {
	Run    execx.Runner // root commands (execx.HelperEnv)
	Files  files.FS
	Log    *Logger
	Events Events
	HTTP   *http.Client // LAN brain probe and the model pull
	Now    func() time.Time
	// ModelRun runs `chroot /target ollama serve`; its environment carries
	// OLLAMA_MODELS and OLLAMA_HOST (see ModelEnv).
	ModelRun func(port int) execx.Runner
	// FreePort returns a free loopback TCP port for that server.
	FreePort func() (int, error)
	// DiskUsed reports bytes used on the file system at path (copy progress).
	DiskUsed func(path string) (int64, error)
	// Every is the polling interval (copy progress, partition nodes); 0 = 1 s.
	Every time.Duration
	// ModelStall aborts a pull that makes no progress for this long; 0 = 2 min.
	ModelStall time.Duration
}

// ModelEnv is the environment of the install-time `ollama serve`: the
// target's models directory as seen inside the chroot, loopback only.
func ModelEnv(port int) []string {
	return append(execx.BaseEnv(), "HOME=/root", "OLLAMA_MODELS=/var/lib/ollama/models",
		"OLLAMA_HOST=127.0.0.1:"+strconv.Itoa(port))
}

func (d Deps) every() time.Duration {
	if d.Every == 0 {
		return time.Second
	}
	return d.Every
}

// CmdError is a command that ran and failed.
type CmdError struct {
	Argv   string
	Exit   int
	Stderr string
}

func (e *CmdError) Error() string {
	return fmt.Sprintf("%s exited with %d: %s", e.Argv, e.Exit, lastLine(e.Stderr))
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

var errCancelled = errors.New("cancelled")

// job is one Execute run.
type job struct {
	d       Deps
	pl      Planned
	sec     Secrets
	secrets []string
	step    string

	rootDev  string // what holds the root file system
	opened   bool   // LUKS mapping is open
	mounted  bool   // /target is mounted
	rootUUID string
	espUUID  string
	bootUUID string // the separate /boot, encrypted installs only
	luksUUID string
	swapUUID string
	user     parse.PasswdEntry

	notes []string // Done-screen notes: the Finished message on success
	x     tr       // the install's language (Choices.locale, M4 contracts §6.6)

	modelCancel context.CancelFunc
	modelDone   chan error
}

// Execute runs pl to the end and reports through d.Events; it always ends
// with exactly one Finished. Secrets reach child processes on stdin only.
func Execute(ctx context.Context, d Deps, pl Planned, sec Secrets, gate *Gate) {
	j := &job{d: d, pl: pl, sec: sec, rootDev: pl.Layout.Root.Path, x: trFor(pl.Choices)}
	for _, s := range []string{sec.UserPassword, deref(sec.LUKSPassphrase)} {
		if s != "" {
			d.Log.AddSecret(s)
			j.secrets = append(j.secrets, s)
		}
	}
	err := j.run(ctx, gate)
	switch {
	case errors.Is(err, errCancelled):
		d.Log.Printf("cancelled before any change")
		d.Events.Finished(false, "", j.tx().t.Cancelled)
	case err != nil:
		d.Log.Printf("FAILED in %s: %v", j.step, err)
		j.cleanup()
		d.Events.Finished(false, j.step, strings.Join(d.Log.Tail(20), "\n"))
	default:
		d.Log.Printf("%s", textEN.Done) // the log stays English
		d.Events.Finished(true, "", strings.Join(j.notes, "\n"))
	}
}

// tx is the install's language; a job built without one (tests, dry run)
// takes it from its plan's Choices.
func (j *job) tx() tr {
	if j.x.t.Done == "" {
		return trFor(j.pl.Choices)
	}
	return j.x
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (j *job) begin(step string) {
	j.step = step
	j.d.Log.Printf("== %s", step)
	j.d.Events.Progress(step, 0, "")
}

func (j *job) done() { j.d.Events.Progress(j.step, 100, "") }

// cmd runs one program. It refuses outright if any argument contains a
// secret, logs the argv (never stdin), and turns a non-zero exit into a
// CmdError.
func (j *job) cmd(ctx context.Context, timeout time.Duration, stdin []byte, name string, args ...string) (execx.Result, error) {
	for _, a := range append([]string{name}, args...) {
		for _, s := range j.secrets {
			if len(s) >= minSecretLen && strings.Contains(a, s) {
				return execx.Result{}, fmt.Errorf("refusing to run %s: a secret would appear in its arguments", name)
			}
		}
	}
	argv := showArgv(name, args)
	j.d.Log.Printf("$ %s", argv)
	res, err := j.d.Run.Run(ctx, execx.Cmd{Name: name, Args: args, Stdin: stdin, Timeout: timeout})
	if err != nil {
		return res, fmt.Errorf("%s: %w", argv, err)
	}
	if tail := strings.TrimSpace(string(res.Stderr)); tail != "" {
		j.d.Log.Printf("  %s", lastLines(tail, 5))
	}
	if res.ExitCode != 0 {
		return res, &CmdError{Argv: argv, Exit: res.ExitCode, Stderr: string(res.Stderr)}
	}
	return res, nil
}

// showArgv renders argv for the log and error messages, quoting any
// argument with spaces or control characters so one line stays one line.
func showArgv(name string, args []string) string {
	parts := []string{name}
	for _, a := range args {
		if a == "" || strings.ContainsAny(a, " \t\n\"'") {
			a = strconv.Quote(a)
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

func (j *job) must(ctx context.Context, timeout time.Duration, name string, args ...string) error {
	_, err := j.cmd(ctx, timeout, nil, name, args...)
	return err
}

func lastLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n  ")
}

func (j *job) run(ctx context.Context, gate *Gate) error {
	lay := j.pl.Layout
	first := "format"
	if lay.Mode != "manual" {
		first = "partition"
	} else if lay.Encrypt {
		first = "encrypt"
	}
	j.step = first
	j.d.Events.Progress(first, 0, j.tx().t.Preflight)
	if err := j.preflight(ctx); err != nil {
		return err
	}
	if !gate.Commit() {
		return errCancelled
	}
	j.d.Log.Printf("plan %s: %s", j.pl.Public.PlanID, strings.Join(j.pl.Public.Summary, " | "))
	if !j.pl.SecureBoot {
		j.notes = append(j.notes, j.tx().t.NoteSecureBootOff)
	}
	if lay.Mode != "manual" {
		if err := j.partition(ctx); err != nil {
			return err
		}
	}
	if lay.Encrypt {
		if err := j.encrypt(ctx); err != nil {
			return err
		}
	}
	for _, f := range []func(context.Context) error{j.format, j.copy, j.startModel, j.configure, j.bootloader, j.waitModel, j.finish} {
		if err := f(ctx); err != nil {
			return err
		}
	}
	return nil
}

// preflight re-reads the disk and the system right before the first write:
// the partition table must be exactly the one the plan was made from,
// nothing on the disk may be mounted or used as swap, and no earlier
// attempt may still hold /target or the LUKS mapping.
func (j *job) preflight(ctx context.Context) error {
	disk := j.pl.Disk
	mounts, _ := j.d.Files.ReadFile("/proc/mounts")
	for _, m := range parse.ProcMounts(string(mounts)) {
		if m.Target == Target || strings.HasPrefix(m.Target, Target+"/") {
			return fmt.Errorf("%s is still mounted from an earlier attempt; restart the computer and try again", Target)
		}
		if onDisk(disk, m.Source) {
			return fmt.Errorf("%s is in use (mounted at %s); close it and try again", m.Source, m.Target)
		}
	}
	swaps, _ := j.d.Files.ReadFile("/proc/swaps")
	for _, s := range parse.ProcSwaps(string(swaps)) {
		if onDisk(disk, s) {
			return fmt.Errorf("%s is in use as swap; restart the computer and try again", s)
		}
	}
	if j.d.Files.Exists(MapperPath) {
		return fmt.Errorf("%s is still open from an earlier attempt; restart the computer and try again", MapperPath)
	}
	res, err := j.cmd(ctx, time.Minute, nil, "sgdisk", "-p", disk.Path)
	if err != nil {
		return err
	}
	g, err := parse.SgdiskPrint(string(res.Stdout))
	if err != nil || !sameTable(disk, g) {
		return errors.New(j.tx().t.DiskChanged)
	}
	return nil
}

func onDisk(d Disk, dev string) bool {
	if dev == d.Path {
		return true
	}
	for _, p := range d.Partitions {
		if p.Path == dev {
			return true
		}
	}
	return false
}

func sameTable(d Disk, g parse.GPTGeometry) bool {
	if len(d.Partitions) != len(g.Partitions) || g.LastUsable != d.LastUsable {
		return false
	}
	want := map[int][2]int64{}
	for _, p := range d.Partitions {
		want[p.Number] = [2]int64{p.Start, p.End}
	}
	for _, p := range g.Partitions {
		if want[p.Number] != [2]int64{p.Start, p.End} {
			return false
		}
	}
	return true
}

const (
	quick    = 2 * time.Minute
	slow     = 15 * time.Minute
	verySlow = 3 * time.Hour
)

// plannedCmd is one disk-changing command of the partition step.
type plannedCmd struct {
	Argv     []string
	Stdin    []byte
	Timeout  time.Duration
	Progress int
	Detail   string
}

// partitionCommands is the partition step as data, so `--dry-run` prints
// exactly what Execute runs.
func partitionCommands(lay Layout, disk Disk) []plannedCmd {
	var out []plannedCmd
	add := func(c plannedCmd) { out = append(out, c) }
	if disk.GPT {
		// A copy of the table as it was; finish puts it in /var/log.
		add(plannedCmd{Argv: []string{"sgdisk", "--backup=" + gptBackup, disk.Path}, Timeout: quick})
	}
	if lay.Wipe {
		add(plannedCmd{Argv: []string{"sgdisk", "--zap-all", disk.Path}, Timeout: quick})
	}
	if s := lay.Shrink; s != nil {
		size := strconv.FormatInt(s.NewBytes, 10)
		add(plannedCmd{Argv: []string{"ntfsresize", "--no-action", "--no-progress-bar", "--size", size, s.Part.Path}, Timeout: slow, Progress: 5, Detail: "Checking Windows"})
		// ntfsresize asks "Are you sure you want to proceed (y/[n])?".
		add(plannedCmd{Argv: []string{"ntfsresize", "--no-progress-bar", "--size", size, s.Part.Path}, Stdin: []byte("y\n"), Timeout: verySlow, Progress: 10, Detail: "Shrinking Windows"})
		add(plannedCmd{Argv: append([]string{"sgdisk"}, shrinkArgs(*s, disk.Path)...), Timeout: quick, Progress: 80, Detail: "Updating the partition table"})
	}
	add(plannedCmd{Argv: append([]string{"sgdisk"}, createArgs(lay)...), Timeout: quick, Progress: 90})
	add(plannedCmd{Argv: []string{"partx", "-u", disk.Path}, Timeout: quick})
	return out
}

// DryRun lists every command that changes a disk, in order, with secrets
// shown as placeholders. It runs nothing.
func DryRun(pl Planned) []string {
	var out []string
	if pl.Layout.Mode != "manual" {
		for _, c := range partitionCommands(pl.Layout, pl.Disk) {
			line := showArgv(c.Argv[0], c.Argv[1:])
			if c.Stdin != nil {
				line += " <<< " + strconv.Quote(string(c.Stdin))
			}
			out = append(out, line)
		}
	}
	lay := pl.Layout
	if lay.Encrypt {
		out = append(out, "wipefs --all "+lay.Root.Path,
			"cryptsetup luksFormat --type luks2 --pbkdf argon2id --batch-mode --key-file=- "+lay.Root.Path+" <<< <passphrase>",
			"cryptsetup open --type luks2 --key-file=- "+lay.Root.Path+" "+mapperName+" <<< <passphrase>")
	} else {
		out = append(out, "wipefs --all "+lay.Root.Path)
	}
	root := lay.Root.Path
	if lay.Encrypt {
		root = MapperPath
	}
	out = append(out, "mkfs.ext4 -F -q -L jarvis-root "+root)
	if b := lay.Boot; b != nil {
		out = append(out, "wipefs --all "+b.Path, "mkfs.ext4 -F -q -L "+strconv.Quote(bootLabel)+" "+b.Path)
	}
	if lay.ESP.Format {
		out = append(out, "mkfs.vfat -F 32 -n EFI "+lay.ESP.Path)
	}
	if lay.Swap != nil && lay.Swap.Format {
		out = append(out, "mkswap -L jarvis-swap "+lay.Swap.Path)
	}
	return out
}

func (j *job) partition(ctx context.Context) error {
	j.begin("partition")
	lay := j.pl.Layout
	if err := j.d.Files.MkdirAll(RunDir, 0o755); err != nil {
		return err
	}
	for _, c := range partitionCommands(lay, j.pl.Disk) {
		if c.Progress > 0 {
			j.d.Events.Progress("partition", c.Progress, c.Detail)
		}
		if _, err := j.cmd(ctx, c.Timeout, c.Stdin, c.Argv[0], c.Argv[1:]...); err != nil {
			return err
		}
	}
	_ = j.must(ctx, quick, "udevadm", "settle", "--timeout=30")
	if err := j.waitNodes(ctx, lay); err != nil {
		return err
	}
	j.done()
	return nil
}

// shrinkArgs re-creates the Windows entry with the same number, first
// sector, type, unique GUID (Windows' boot configuration refers to it),
// name and attributes, and only a smaller last sector. The file system was
// already shrunk, so the partition is never smaller than it.
func shrinkArgs(s Shrink, disk string) []string {
	p := s.Part
	n := strconv.Itoa(p.Number)
	args := []string{
		"--delete=" + n,
		fmt.Sprintf("--new=%s:%d:%d", n, p.Start, s.NewEnd),
		"--typecode=" + n + ":" + strings.ToUpper(p.TypeGUID),
		"--partition-guid=" + n + ":" + strings.ToUpper(p.UniqueGUID),
	}
	if p.Name != "" {
		args = append(args, "--change-name="+n+":"+p.Name)
	}
	return append(args, fmt.Sprintf("--attributes=%s:=:%016X", n, p.Flags), disk)
}

// createArgs adds the new ESP (if any) and the Rafiq root.
func createArgs(lay Layout) []string {
	var args []string
	add := func(p Part, code, name string) {
		n := strconv.Itoa(p.Number)
		args = append(args, fmt.Sprintf("--new=%s:%d:%d", n, p.Start, p.End), "--typecode="+n+":"+code, "--change-name="+n+":"+name)
	}
	if lay.ESP.Create {
		add(lay.ESP, codeESP, "EFI system partition")
	}
	if lay.Boot != nil && lay.Boot.Create {
		add(*lay.Boot, codeLinuxFS, bootLabel)
	}
	code := codeLinuxRoot
	if lay.Encrypt {
		code = codeLUKS
	}
	add(lay.Root, code, "Rafiq")
	return append(args, lay.Disk)
}

func (j *job) waitNodes(ctx context.Context, lay Layout) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		if j.d.Files.Exists(lay.Root.Path) && j.d.Files.Exists(lay.ESP.Path) && (lay.Boot == nil || j.d.Files.Exists(lay.Boot.Path)) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the new partitions did not appear (%s)", lay.Root.Path)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(j.d.every()):
		}
	}
}

func (j *job) encrypt(ctx context.Context) error {
	j.begin("encrypt")
	root := j.pl.Layout.Root.Path
	pass := []byte(*j.sec.LUKSPassphrase)
	if err := j.must(ctx, quick, "wipefs", "--all", root); err != nil {
		return err
	}
	if _, err := j.cmd(ctx, slow, pass, "cryptsetup", "luksFormat", "--type", "luks2", "--pbkdf", "argon2id", "--batch-mode", "--key-file=-", root); err != nil {
		return err
	}
	j.d.Events.Progress("encrypt", 60, "")
	if _, err := j.cmd(ctx, slow, pass, "cryptsetup", "open", "--type", "luks2", "--key-file=-", root, mapperName); err != nil {
		return err
	}
	j.opened, j.rootDev = true, MapperPath
	j.done()
	return nil
}

func (j *job) uuid(ctx context.Context, dev string) (string, error) {
	res, err := j.cmd(ctx, quick, nil, "blkid", "-s", "UUID", "-o", "value", dev)
	if err != nil {
		return "", err
	}
	u := strings.TrimSpace(string(res.Stdout))
	if u == "" {
		return "", fmt.Errorf("%s has no UUID", dev)
	}
	return u, nil
}

func (j *job) format(ctx context.Context) error {
	j.begin("format")
	lay := j.pl.Layout
	if !lay.Encrypt {
		if err := j.must(ctx, quick, "wipefs", "--all", lay.Root.Path); err != nil {
			return err
		}
	}
	if err := j.must(ctx, slow, "mkfs.ext4", "-F", "-q", "-L", "jarvis-root", j.rootDev); err != nil {
		return err
	}
	if b := lay.Boot; b != nil {
		if err := j.must(ctx, quick, "wipefs", "--all", b.Path); err != nil {
			return err
		}
		if err := j.must(ctx, quick, "mkfs.ext4", "-F", "-q", "-L", bootLabel, b.Path); err != nil {
			return err
		}
	}
	if lay.ESP.Format {
		if err := j.must(ctx, quick, "mkfs.vfat", "-F", "32", "-n", "EFI", lay.ESP.Path); err != nil {
			return err
		}
	}
	if lay.Swap != nil && lay.Swap.Format {
		if err := j.must(ctx, quick, "mkswap", "-L", "jarvis-swap", lay.Swap.Path); err != nil {
			return err
		}
	}
	if err := j.d.Files.MkdirAll(Target, 0o755); err != nil {
		return err
	}
	if err := j.must(ctx, quick, "mount", j.rootDev, Target); err != nil {
		return err
	}
	j.mounted = true
	// /boot is mounted before the copy so the kernel and initramfs land on
	// the unencrypted partition GRUB can read.
	if b := lay.Boot; b != nil {
		if err := j.d.Files.MkdirAll(Target+"/boot", 0o755); err != nil {
			return err
		}
		if err := j.must(ctx, quick, "mount", b.Path, Target+"/boot"); err != nil {
			return err
		}
	}
	if err := j.d.Files.MkdirAll(Target+"/boot/efi", 0o755); err != nil {
		return err
	}
	if err := j.must(ctx, quick, "mount", lay.ESP.Path, Target+"/boot/efi"); err != nil {
		return err
	}
	if err := j.must(ctx, quick, "fallocate", "-l", strconv.FormatInt(SwapFileBytes, 10), Target+"/swapfile"); err != nil {
		return err
	}
	if err := j.d.Files.Chmod(Target+"/swapfile", 0o600); err != nil {
		return err
	}
	if err := j.must(ctx, quick, "mkswap", Target+"/swapfile"); err != nil {
		return err
	}
	var err error
	if j.rootUUID, err = j.uuid(ctx, j.rootDev); err != nil {
		return err
	}
	if j.espUUID, err = j.uuid(ctx, lay.ESP.Path); err != nil {
		return err
	}
	if lay.Boot != nil {
		if j.bootUUID, err = j.uuid(ctx, lay.Boot.Path); err != nil {
			return err
		}
	}
	if lay.Encrypt {
		if j.luksUUID, err = j.uuid(ctx, lay.Root.Path); err != nil {
			return err
		}
	}
	if lay.Swap != nil {
		if j.swapUUID, err = j.uuid(ctx, lay.Swap.Path); err != nil {
			return err
		}
	}
	j.done()
	return nil
}

func (j *job) copy(ctx context.Context) error {
	j.begin("copy")
	var total int64
	if b, err := j.d.Files.ReadFile(squashfsSize); err == nil {
		total, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	if total > 0 && j.d.DiskUsed != nil {
		base, _ := j.d.DiskUsed(Target)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				case <-time.After(j.d.every()):
				}
				if used, err := j.d.DiskUsed(Target); err == nil {
					pct := int((used - base) * 90 / total)
					if pct > 89 {
						pct = 89
					}
					if pct >= 0 {
						j.d.Events.Progress("copy", pct, "")
					}
				}
			}
		}()
	}
	err := j.must(ctx, 90*time.Minute, "unsquashfs", "-f", "-n", "-d", Target, Squashfs)
	close(stop)
	wg.Wait()
	if err != nil {
		return err
	}
	j.d.Events.Progress("copy", 90, "")
	if err := j.bindMounts(ctx); err != nil {
		return err
	}
	res, _ := j.cmd(ctx, quick, nil, "chroot", append([]string{Target, "dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--"}, livePackages...)...)
	var purge []string
	for _, st := range parse.DpkgQuery(string(res.Stdout)) {
		if st.Installed {
			purge = append(purge, st.Name)
		}
	}
	if len(purge) > 0 {
		if err := j.must(ctx, slow, "chroot", append([]string{Target, "apt-get", "purge", "-y", "--"}, purge...)...); err != nil {
			return err
		}
	}
	j.done()
	return nil
}

// bindMounts gives the chroot /dev, /proc, /sys, efivars (grub-install,
// efibootmgr), a fresh /run and the live system's udev database in it:
// os-prober (update-grub) only takes a partition for an EFI system
// partition when udev reports its GPT type, so without /run/udev an
// alongside install got no "Windows Boot Manager" entry and no 3 s menu.
func (j *job) bindMounts(ctx context.Context) error {
	for _, m := range [][]string{
		{"--bind", "/dev", Target + "/dev"},
		{"--bind", "/dev/pts", Target + "/dev/pts"},
		{"-t", "proc", "proc", Target + "/proc"},
		{"-t", "sysfs", "sysfs", Target + "/sys"},
		{"--bind", "/sys/firmware/efi/efivars", Target + "/sys/firmware/efi/efivars"},
		{"-t", "tmpfs", "tmpfs", Target + "/run"},
		{"--bind", "/run/udev", Target + "/run/udev"},
	} {
		if err := j.d.Files.MkdirAll(m[len(m)-1], 0o755); err != nil {
			return err
		}
		if err := j.must(ctx, quick, "mount", m...); err != nil {
			return err
		}
	}
	return nil
}

func (j *job) chroot(ctx context.Context, timeout time.Duration, args ...string) error {
	return j.must(ctx, timeout, "chroot", append([]string{Target}, args...)...)
}

func (j *job) write(name, content string, perm fs.FileMode) error {
	return j.d.Files.WriteFile(Target+name, []byte(content), perm)
}

func (j *job) configure(ctx context.Context) error {
	j.begin("configure")
	c, lay := j.pl.Choices, j.pl.Layout
	steps := []func() error{
		func() error { return j.write("/etc/machine-id", "", 0o444) },
		func() error {
			return j.write("/etc/fstab", renderFstab(j.rootUUID, j.bootUUID, j.espUUID, j.swapUUID), 0o644)
		},
		func() error {
			if !lay.Encrypt {
				return nil
			}
			if err := j.write("/etc/crypttab", renderCrypttab(j.luksUUID), 0o600); err != nil {
				return err
			}
			if err := j.d.Files.MkdirAll(Target+"/etc/cryptsetup-initramfs", 0o755); err != nil {
				return err
			}
			return j.write("/etc/cryptsetup-initramfs/conf-hook", cryptsetupConfHook, 0o644)
		},
		func() error { return j.write("/etc/hostname", c.User.Hostname+"\n", 0o644) },
		func() error { return j.write("/etc/hosts", renderHosts(c.User.Hostname), 0o644) },
		func() error { return j.write("/etc/locale.gen", renderLocaleGen(c.Locale), 0o644) },
		func() error { return j.chroot(ctx, slow, "locale-gen") },
		func() error { return j.write("/etc/default/locale", renderDefaultLocale(c.Locale), 0o644) },
		func() error { return j.write("/etc/default/keyboard", renderKeyboard(c.Keyboard), 0o644) },
		func() error { return j.write("/etc/vconsole.conf", renderVconsole(c.Keyboard), 0o644) },
		func() error { return j.timezone(c.Timezone) },
		func() error { return j.chroot(ctx, quick, "groupadd", "-f", "-r", "jarvis-admins") },
		func() error { return j.chroot(ctx, quick, "groupadd", "-f", "-r", "netdev") },
		func() error {
			return j.chroot(ctx, quick, "useradd", "-m", "-s", "/bin/bash", "-c", c.User.FullName, "-G", userGroups, "--", c.User.Username)
		},
		func() error {
			_, err := j.cmd(ctx, quick, []byte(c.User.Username+":"+j.sec.UserPassword+"\n"), "chroot", Target, "chpasswd")
			return err
		},
		func() error { return j.readUser(c.User.Username) },
		func() error { return j.greetd(c.User.Username, c.User.Autologin) },
		func() error { return j.brainConfig(ctx) },
		func() error { return j.initramfs(ctx) },
	}
	for i, f := range steps {
		if err := f(); err != nil {
			return err
		}
		j.d.Events.Progress("configure", (i+1)*100/len(steps)-1, "")
	}
	j.done()
	return nil
}

func (j *job) timezone(tz string) error {
	zone := "/usr/share/zoneinfo/" + tz
	if !j.d.Files.Exists(Target + zone) {
		return fmt.Errorf("unknown time zone %s", tz)
	}
	if err := j.d.Files.Remove(Target + "/etc/localtime"); err != nil {
		return err
	}
	if err := j.d.Files.Symlink(zone, Target+"/etc/localtime"); err != nil {
		return err
	}
	return j.write("/etc/timezone", tz+"\n", 0o644)
}

func (j *job) readUser(name string) error {
	b, err := j.d.Files.ReadFile(Target + "/etc/passwd")
	if err != nil {
		return err
	}
	for _, e := range parse.Passwd(string(b)) {
		if e.Name == name {
			j.user = e
			return nil
		}
	}
	return fmt.Errorf("user %s was not created", name)
}

func (j *job) greetd(username string, autologin bool) error {
	const conf = "/etc/greetd/config.toml"
	b, err := j.d.Files.ReadFile(Target + conf)
	if err != nil {
		if autologin {
			return fmt.Errorf("%s is missing; jarvis-greeter is not installed", conf)
		}
		return nil
	}
	out := greetdAutologin(string(b), username, autologin)
	if out == string(b) {
		return nil
	}
	return j.write(conf, out, 0o644)
}

// brainConfig writes ~/.config/jarvis/jarvis.yaml (M2 contracts §6): the
// provider, and os.language: ar for an Arabic install (M4 contracts §6.6).
// A cloud brain with an English install writes nothing.
func (j *job) brainConfig(ctx context.Context) error {
	b := j.pl.Choices.Brain
	var kind, base, model, lang string
	if j.tx().l == i18n.AR {
		lang = string(i18n.AR)
	}
	switch b.Kind {
	case "cloud":
		if lang == "" {
			return nil
		}
	case "local":
		kind, base, model = "ollama", "http://127.0.0.1:11434", j.pl.Model.OllamaTag
	case "lan":
		base, _ = normalizeBaseURL(b.BaseURL)
		kind, model = j.lanKind(ctx, base), b.Model
	}
	home := Target + j.user.Home
	dirs := []string{home + "/.config", home + "/.config/jarvis"}
	for _, d := range dirs {
		if err := j.d.Files.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	file := home + "/.config/jarvis/jarvis.yaml"
	if err := j.d.Files.WriteFile(file, []byte(renderJarvisYAML(kind, base, model, lang)), 0o600); err != nil {
		return err
	}
	for _, p := range append(dirs, file) {
		if err := j.d.Files.Chown(p, j.user.UID, j.user.GID); err != nil {
			return err
		}
	}
	return nil
}

// lanKind asks the server what it is: Ollama answers /api/tags, an
// OpenAI-compatible server /v1/models. Unreachable means
// openai-compatible; the user can change it in Settings.
func (j *job) lanKind(ctx context.Context, base string) string {
	if j.d.HTTP == nil {
		return "openai-compatible"
	}
	for _, probe := range []struct{ path, kind string }{{"/api/tags", "ollama"}, {"/v1/models", "openai-compatible"}} {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		req, _ := http.NewRequestWithContext(cctx, http.MethodGet, base+probe.path, nil)
		resp, err := j.d.HTTP.Do(req)
		cancel()
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				j.d.Log.Printf("LAN brain %s answers %s: %s", base, probe.path, probe.kind)
				return probe.kind
			}
		}
	}
	j.d.Log.Printf("LAN brain %s did not answer; assuming openai-compatible", base)
	return "openai-compatible"
}

// initramfs makes sure every kernel has its image in /boot (copied from
// the live medium if the squashfs left /boot empty) and an initramfs with
// cryptsetup and the keymap.
func (j *job) initramfs(ctx context.Context) error {
	kernels, _ := j.d.Files.Glob(Target + "/boot/vmlinuz-*")
	if len(kernels) == 0 {
		mods, _ := j.d.Files.Glob(Target + "/usr/lib/modules/*")
		for _, m := range mods {
			ver := path.Base(m)
			src := LiveMedium + "/live/vmlinuz-" + ver
			if !j.d.Files.Exists(src) {
				src = LiveMedium + "/live/vmlinuz"
			}
			if err := j.must(ctx, quick, "cp", "--", src, Target+"/boot/vmlinuz-"+ver); err != nil {
				return err
			}
			kernels = append(kernels, Target+"/boot/vmlinuz-"+ver)
		}
	}
	if len(kernels) == 0 {
		return errors.New("no kernel found in the copied system")
	}
	for _, k := range kernels {
		ver := strings.TrimPrefix(path.Base(k), "vmlinuz-")
		mode := "-c"
		if j.d.Files.Exists(Target + "/boot/initrd.img-" + ver) {
			mode = "-u"
		}
		if err := j.chroot(ctx, slow, "update-initramfs", mode, "-k", ver); err != nil {
			return err
		}
	}
	return nil
}

func (j *job) bootloader(ctx context.Context) error {
	j.begin("bootloader")
	lay := j.pl.Layout
	if err := j.d.Files.MkdirAll(Target+"/etc/default/grub.d", 0o755); err != nil {
		return err
	}
	if err := j.write("/etc/default/grub.d/jarvis.cfg", renderGrub(lay.DualBoot), 0o644); err != nil {
		return err
	}
	// Debian's signed GRUB has its prefix built in as /EFI/debian, so the
	// bootloader id must be "debian" (Plan H, Secure Boot).
	args := []string{"grub-install", "--target=x86_64-efi", "--efi-directory=/boot/efi", "--bootloader-id=debian", "--uefi-secure-boot", "--no-nvram"}
	if lay.FallbackBoot {
		args = append(args, "--force-extra-removable")
	}
	if err := j.chroot(ctx, slow, args...); err != nil {
		return err
	}
	j.d.Events.Progress("bootloader", 50, "")
	if err := j.nvram(ctx); err != nil {
		if !lay.FallbackBoot {
			return err
		}
		j.d.Log.Printf("warning: no firmware boot entry (%v); the fallback loader \\EFI\\BOOT\\BOOTX64.EFI starts Rafiq", err)
		j.notes = append(j.notes, j.tx().t.NoteNoNVRAM)
	}
	if err := j.chroot(ctx, slow, "update-grub"); err != nil {
		return err
	}
	j.done()
	return nil
}

// nvram replaces any "Rafiq" firmware entry with one for shim.
func (j *job) nvram(ctx context.Context) error {
	res, err := j.cmd(ctx, quick, nil, "efibootmgr")
	if err != nil {
		return err
	}
	for _, e := range parse.EFIBootMgr(string(res.Stdout)) {
		if e.Label == "Rafiq" {
			if err := j.must(ctx, quick, "efibootmgr", "--delete-bootnum", "--bootnum", e.Num); err != nil {
				return err
			}
		}
	}
	lay := j.pl.Layout
	return j.must(ctx, quick, "efibootmgr", "--create", "--disk", lay.Disk, "--part", strconv.Itoa(lay.ESP.Number),
		"--label", "Rafiq", "--loader", `\EFI\debian\shimx64.efi`)
}

func (j *job) finish(ctx context.Context) error {
	if j.pl.Model != nil {
		if b, err := j.d.Files.ReadFile(Target + "/etc/passwd"); err == nil {
			for _, e := range parse.Passwd(string(b)) {
				if e.Name == "ollama" {
					if err := j.chroot(ctx, slow, "chown", "-R", "ollama:ollama", "/var/lib/ollama"); err != nil {
						return err
					}
				}
			}
		}
	}
	if err := j.d.Files.MkdirAll(Target+"/var/log", 0o755); err != nil {
		return err
	}
	if b, err := j.d.Files.ReadFile(gptBackup); err == nil {
		if err := j.d.Files.WriteFile(targetGPTCopy, b, 0o600); err != nil {
			return err
		}
	}
	j.d.Log.Printf("== done")
	if err := j.d.Files.WriteFile(TargetLogPath, j.d.Log.Bytes(), 0o640); err != nil {
		return err
	}
	if err := j.must(ctx, slow, "sync"); err != nil {
		return err
	}
	if err := j.must(ctx, quick, "umount", "-R", Target); err != nil {
		return err
	}
	j.mounted = false
	if j.opened {
		if err := j.must(ctx, quick, "cryptsetup", "close", mapperName); err != nil {
			return err
		}
		j.opened = false
	}
	return nil
}

// cleanup after a failure: stop the model download, leave nothing mounted
// or open so Restart is clean. Errors are logged, not returned.
func (j *job) cleanup() {
	ctx := context.Background()
	if j.modelCancel != nil {
		j.modelCancel()
		<-j.modelDone
	}
	if j.mounted {
		if b := j.d.Log.Bytes(); len(b) > 0 {
			_ = j.d.Files.WriteFile(TargetLogPath, b, 0o640)
		}
		_, _ = j.cmd(ctx, quick, nil, "umount", "-R", Target)
	}
	if j.opened {
		_, _ = j.cmd(ctx, quick, nil, "cryptsetup", "close", mapperName)
	}
}
