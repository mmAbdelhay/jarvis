package install

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/modelstate"
)

const (
	userPW   = "hunter2-very-secret"
	luksPass = "correct horse battery staple"
)

// events records every signal.
type events struct {
	mu       sync.Mutex
	progress []string
	model    []int
	finished []string
}

func (e *events) Progress(step string, pct int, _ string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.progress = append(e.progress, fmt.Sprintf("%s:%d", step, pct))
}
func (e *events) ModelProgress(pct int, _ string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.model = append(e.model, pct)
}
func (e *events) Finished(ok bool, step, msg string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.finished = append(e.finished, fmt.Sprintf("%v|%s|%s", ok, step, msg))
}

// script is an execx.Fake that also remembers the order it expects.
type script struct {
	*execx.Fake
	want [][]string
}

func (s *script) on(res execx.Result, argv ...string) *script {
	s.Fake.On(res, argv[0], argv[1:]...)
	s.want = append(s.want, argv)
	return s
}

func (s *script) ok(argv ...string) *script { return s.on(execx.OK(""), argv...) }

func (s *script) ran() [][]string {
	var out [][]string
	for _, c := range s.Calls {
		out = append(out, append([]string{c.Name}, c.Args...))
	}
	return out
}

const nvmeSgdisk = "Disk /dev/nvme0n1: 500118192 sectors, 238.5 GiB\nSector size (logical/physical): 512/512 bytes\nFirst usable sector is 34, last usable sector is 500118158\nPartitions will be aligned on 2048-sector boundaries\n\nNumber  Start (sector)    End (sector)  Size       Code  Name\n"

// targetTree pre-populates /target as unsquashfs would have.
func targetTree(t *testing.T, root string) {
	put(t, root, "/dev/nvme0n1p1", "")
	put(t, root, "/dev/nvme0n1p2", "")
	put(t, root, "/dev/nvme0n1p3", "")
	put(t, root, "/proc/mounts", "/dev/sdb1 /run/live/medium iso9660 ro 0 0\n")
	put(t, root, "/proc/swaps", "Filename Type Size Used Priority\n")
	put(t, root, "/target/swapfile", "")
	put(t, root, "/target/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nollama:x:996:996::/var/lib/ollama:/usr/sbin/nologin\nada:x:1000:1000:Ada Lovelace:/home/ada:/bin/bash\n")
	put(t, root, "/target/etc/greetd/config.toml", packagedGreetd)
	put(t, root, "/target/usr/share/zoneinfo/Africa/Cairo", "TZif")
	put(t, root, "/target/etc/localtime", "old")
	put(t, root, "/target/boot/vmlinuz-6.12.48+deb13-amd64", "kernel")
	put(t, root, "/target/boot/initrd.img-6.12.48+deb13-amd64", "initrd")
	put(t, root, "/target/home/ada/.profile", "")
	put(t, root, "/target/etc/default/grub", "GRUB_DEFAULT=0\n")
}

// fakeOllama serves the install-time pull and returns its port.
func fakeOllama(t *testing.T, fail bool) (int, *httptest.Server) {
	mux := http.NewServeMux()
	have := false
	var mu sync.Mutex
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"version":"0.12.3"}`) })
	mux.HandleFunc("/api/pull", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		if in["model"] != "qwen3:4b" || fail {
			fmt.Fprintln(w, `{"error":"pull model manifest: connection reset"}`)
			return
		}
		fmt.Fprintln(w, `{"status":"pulling a","digest":"sha256:a","total":100,"completed":40}`)
		fmt.Fprintln(w, `{"status":"pulling a","digest":"sha256:a","total":100,"completed":100}`)
		fmt.Fprintln(w, `{"status":"success"}`)
		mu.Lock()
		have = true
		mu.Unlock()
	})
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if have {
			fmt.Fprint(w, `{"models":[{"name":"qwen3:4b","model":"qwen3:4b"}]}`)
		} else {
			fmt.Fprint(w, `{"models":[]}`)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port, srv
}

type serveRunner struct {
	mu    sync.Mutex
	calls []execx.Cmd
	port  int
}

func (s *serveRunner) Run(ctx context.Context, c execx.Cmd) (execx.Result, error) {
	s.mu.Lock()
	s.calls = append(s.calls, c)
	s.mu.Unlock()
	<-ctx.Done() // `ollama serve` runs until stopped
	return execx.Result{ExitCode: -1}, ctx.Err()
}

type harness struct {
	run   *script
	fs    *files.OS
	root  string
	ev    *events
	serve *serveRunner
	log   bytes.Buffer
	deps  Deps
}

func newHarness(t *testing.T, ollamaFails bool) *harness {
	h := &harness{run: &script{Fake: &execx.Fake{}}, root: t.TempDir(), ev: &events{}, serve: &serveRunner{}}
	h.fs = &files.OS{Root: h.root, RecordChown: true}
	targetTree(t, h.root)
	port, srv := fakeOllama(t, ollamaFails)
	h.deps = Deps{
		Run: h.run, Files: h.fs, Log: NewLogger(&h.log, nil), Events: h.ev, HTTP: srv.Client(),
		Now:      func() time.Time { return time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC) },
		ModelRun: func(p int) execx.Runner { h.serve.port = p; return h.serve },
		FreePort: func() (int, error) { return port, nil },
		Every:    5 * time.Millisecond, ModelStall: time.Second,
	}
	return h
}

func (h *harness) read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(h.root, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const uuidArgs = "blkid -s UUID -o value"

// eraseScript is every command of an erase + encrypt + local-model install,
// in order.
func eraseScript(t *testing.T, h *harness) {
	h.run.on(execx.OK(nvmeSgdisk), "sgdisk", "-p", "/dev/nvme0n1").
		ok("sgdisk", "--zap-all", "/dev/nvme0n1").
		ok("sgdisk", "--new=1:2048:1050623", "--typecode=1:ef00", "--change-name=1:EFI system partition",
			"--new=2:1050624:3147775", "--typecode=2:8300", "--change-name=2:Rafiq boot",
			"--new=3:3147776:500118158", "--typecode=3:8309", "--change-name=3:Rafiq", "/dev/nvme0n1").
		ok("partx", "-u", "/dev/nvme0n1").
		ok("udevadm", "settle", "--timeout=30").
		ok("wipefs", "--all", "/dev/nvme0n1p3").
		ok("cryptsetup", "luksFormat", "--type", "luks2", "--pbkdf", "argon2id", "--batch-mode", "--key-file=-", "/dev/nvme0n1p3").
		ok("cryptsetup", "open", "--type", "luks2", "--key-file=-", "/dev/nvme0n1p3", "jarvis-root").
		ok("mkfs.ext4", "-F", "-q", "-L", "jarvis-root", "/dev/mapper/jarvis-root").
		ok("wipefs", "--all", "/dev/nvme0n1p2").
		ok("mkfs.ext4", "-F", "-q", "-L", "Rafiq boot", "/dev/nvme0n1p2").
		ok("mkfs.vfat", "-F", "32", "-n", "EFI", "/dev/nvme0n1p1").
		ok("mount", "/dev/mapper/jarvis-root", "/target").
		ok("mount", "/dev/nvme0n1p2", "/target/boot").
		ok("mount", "/dev/nvme0n1p1", "/target/boot/efi").
		ok("fallocate", "-l", "2147483648", "/target/swapfile").
		ok("mkswap", "/target/swapfile").
		on(execx.OK("a9dbc795-04e8-4e28-aea5-a308cf08820b\n"), append(strings.Fields(uuidArgs), "/dev/mapper/jarvis-root")...).
		on(execx.OK("6968-B22C\n"), append(strings.Fields(uuidArgs), "/dev/nvme0n1p1")...).
		on(execx.OK("0b7e5a51-3c1d-4f0e-9a37-6a1f0c2d9e11\n"), append(strings.Fields(uuidArgs), "/dev/nvme0n1p2")...).
		on(execx.OK("dc3595e8-0075-459c-8ae6-70871177a5d6\n"), append(strings.Fields(uuidArgs), "/dev/nvme0n1p3")...).
		ok("unsquashfs", "-f", "-n", "-d", "/target", "/run/live/medium/live/filesystem.squashfs").
		ok("mount", "--bind", "/dev", "/target/dev").
		ok("mount", "--bind", "/dev/pts", "/target/dev/pts").
		ok("mount", "-t", "proc", "proc", "/target/proc").
		ok("mount", "-t", "sysfs", "sysfs", "/target/sys").
		ok("mount", "--bind", "/sys/firmware/efi/efivars", "/target/sys/firmware/efi/efivars").
		ok("mount", "-t", "tmpfs", "tmpfs", "/target/run").
		ok("mount", "--bind", "/run/udev", "/target/run/udev").
		on(execx.Result{Stdout: []byte("live-boot\t1:20240525\tinstalled\nlive-config\t11.0.5\tinstalled\njarvis-installer\t0.2.0\tinstalled\nlive-tools\t\tnot-installed\n"), ExitCode: 1},
			"chroot", "/target", "dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--",
			"live-boot", "live-boot-initramfs-tools", "live-config", "live-config-systemd", "live-tools", "jarvis-installer", "jarvis-installer-backend").
		ok("chroot", "/target", "apt-get", "purge", "-y", "--", "live-boot", "live-config", "jarvis-installer").
		ok("chroot", "/target", "locale-gen").
		ok("chroot", "/target", "groupadd", "-f", "-r", "jarvis-admins").
		ok("chroot", "/target", "groupadd", "-f", "-r", "netdev").
		ok("chroot", "/target", "useradd", "-m", "-s", "/bin/bash", "-c", "Ada Lovelace", "-G", "sudo,jarvis-admins,netdev,systemd-journal", "--", "ada").
		ok("chroot", "/target", "chpasswd").
		ok("chroot", "/target", "update-initramfs", "-u", "-k", "6.12.48+deb13-amd64").
		ok("chroot", "/target", "grub-install", "--target=x86_64-efi", "--efi-directory=/boot/efi", "--bootloader-id=debian",
			"--uefi-secure-boot", "--no-nvram", "--force-extra-removable").
		on(execx.OK(fx(t, "efibootmgr.txt")), "efibootmgr").
		ok("efibootmgr", "--delete-bootnum", "--bootnum", "0003").
		ok("efibootmgr", "--create", "--disk", "/dev/nvme0n1", "--part", "1", "--label", "Rafiq", "--loader", `\EFI\debian\shimx64.efi`).
		ok("chroot", "/target", "update-grub").
		ok("chroot", "/target", "chown", "-R", "ollama:ollama", "/var/lib/ollama").
		ok("sync").
		ok("umount", "-R", "/target").
		ok("cryptsetup", "close", "jarvis-root")
}

func erasePlan(t *testing.T) Planned {
	pl, err := MakePlan(choices("erase", "/dev/nvme0n1"), probe(emptyDisk()), "plan-1")
	if err != nil {
		t.Fatal(err)
	}
	return pl
}

func secrets() Secrets { return Secrets{UserPassword: userPW, LUKSPassphrase: str(luksPass)} }

func TestExecuteEraseEncryptLocalModel(t *testing.T) {
	h := newHarness(t, false)
	eraseScript(t, h)
	Execute(context.Background(), h.deps, erasePlan(t), secrets(), &Gate{})

	if !reflect.DeepEqual(h.ev.finished, []string{"true||"}) {
		t.Fatalf("finished = %v\nlog:\n%s", h.ev.finished, h.log.String())
	}
	if got := h.run.ran(); !reflect.DeepEqual(got, h.run.want) {
		for i := range got {
			if i >= len(h.run.want) || !reflect.DeepEqual(got[i], h.run.want[i]) {
				t.Fatalf("command %d\n got %q\nwant %q", i, got[i], h.run.want[min(i, len(h.run.want)-1)])
			}
		}
		t.Fatalf("ran %d commands, want %d", len(got), len(h.run.want))
	}

	// Secrets: only on stdin, only where needed, exactly.
	for _, c := range h.run.Calls {
		argv := strings.Join(append([]string{c.Name}, c.Args...), " ")
		if strings.Contains(argv, userPW) || strings.Contains(argv, luksPass) {
			t.Fatalf("secret in argv: %s", argv)
		}
		switch {
		case c.Name == "cryptsetup" && (c.Args[0] == "luksFormat" || c.Args[0] == "open"):
			if string(c.Stdin) != luksPass {
				t.Fatalf("%s stdin = %q (no newline: --key-file=- reads every byte)", c.Args[0], c.Stdin)
			}
		case c.Name == "chroot" && c.Args[1] == "chpasswd":
			if string(c.Stdin) != "ada:"+userPW+"\n" {
				t.Fatalf("chpasswd stdin = %q", c.Stdin)
			}
		default:
			if c.Stdin != nil {
				t.Fatalf("%s got stdin", argv)
			}
		}
	}

	// Files, byte for byte.
	want := map[string]string{
		"/target/etc/fstab":                           "# /etc/fstab: written by the Rafiq installer.\nUUID=a9dbc795-04e8-4e28-aea5-a308cf08820b / ext4 errors=remount-ro 0 1\nUUID=0b7e5a51-3c1d-4f0e-9a37-6a1f0c2d9e11 /boot ext4 defaults 0 2\nUUID=6968-B22C /boot/efi vfat umask=0077 0 1\n/swapfile none swap sw 0 0\n",
		"/target/etc/crypttab":                        "# <target name> <source device> <key file> <options>\njarvis-root UUID=dc3595e8-0075-459c-8ae6-70871177a5d6 none luks,discard,initramfs,tries=0\n",
		"/target/etc/cryptsetup-initramfs/conf-hook":  cryptsetupConfHook,
		"/target/etc/hostname":                        "ada-laptop\n",
		"/target/etc/locale.gen":                      "en_US.UTF-8 UTF-8\n",
		"/target/etc/default/locale":                  "LANG=en_US.UTF-8\n",
		"/target/etc/default/keyboard":                "XKBMODEL=\"pc105\"\nXKBLAYOUT=\"us\"\nXKBVARIANT=\"\"\nXKBOPTIONS=\"\"\nBACKSPACE=\"guess\"\n",
		"/target/etc/vconsole.conf":                   "# Written by the Rafiq installer: the disk unlock prompt's keyboard.\nXKBLAYOUT=us\nXKBMODEL=pc105\nXKBVARIANT=\nXKBOPTIONS=\n",
		"/target/etc/timezone":                        "Africa/Cairo\n",
		"/target/etc/machine-id":                      "",
		"/target/etc/greetd/config.toml":              packagedGreetd, // untouched without autologin
		"/target/etc/default/grub.d/jarvis.cfg":       "# Written by the Rafiq installer.\nGRUB_DISTRIBUTOR=\"Rafiq\"\nGRUB_CMDLINE_LINUX_DEFAULT=\"quiet splash\"\nGRUB_DISABLE_OS_PROBER=false\nGRUB_TIMEOUT=0\nGRUB_TIMEOUT_STYLE=hidden\nGRUB_THEME=/usr/share/grub/themes/jarvis/theme.txt\n",
		"/target/home/ada/.config/jarvis/jarvis.yaml": "# Written by the Rafiq installer. Change it in Settings.\nprovider:\n  kind: ollama\n  baseUrl: \"http://127.0.0.1:11434\"\n  model: \"qwen3:4b\"\n",
	}
	for name, content := range want {
		if got := h.read(t, name); got != content {
			t.Errorf("%s\n got %q\nwant %q", name, got, content)
		}
	}
	if h.fs.Exists("/target/etc/apt/sources.list.d/jarvis.sources") {
		t.Error("jarvis.sources is shipped by jarvis-archive-keyring; the installer must not write it")
	}
	if l, _ := os.Readlink(filepath.Join(h.root, "target/etc/localtime")); l != "/usr/share/zoneinfo/Africa/Cairo" {
		t.Errorf("localtime -> %q", l)
	}
	for name, mode := range map[string]os.FileMode{"/target/etc/crypttab": 0o600, "/target/home/ada/.config/jarvis/jarvis.yaml": 0o600, "/target/swapfile": 0o600, "/target/var/log/jarvis-installer.log": 0o640} {
		if st, err := os.Stat(filepath.Join(h.root, name)); err != nil || st.Mode().Perm() != mode {
			t.Errorf("%s mode = %v, %v", name, st.Mode(), err)
		}
	}
	if got := h.fs.Chowned(); !reflect.DeepEqual(got, []string{"/target/home/ada/.config 1000:1000", "/target/home/ada/.config/jarvis 1000:1000", "/target/home/ada/.config/jarvis/jarvis.yaml 1000:1000"}) {
		t.Errorf("chowned = %v", got)
	}

	// Model: pulled through `chroot /target ollama serve` on the free port.
	if len(h.serve.calls) != 1 || strings.Join(h.serve.calls[0].Args, " ") != "/target ollama serve" || h.serve.calls[0].Name != "chroot" {
		t.Fatalf("serve = %+v", h.serve.calls)
	}
	st, err := modelstate.Read(h.fs, Target)
	if err != nil || st.State != modelstate.Ready || st.Percent != 100 || st.OllamaTag != "qwen3:4b" {
		t.Fatalf("model state = %+v, %v", st, err)
	}
	if modelstate.IsPending(h.fs, Target) {
		t.Fatal("marker must be gone after a successful pull")
	}
	if fmt.Sprint(h.ev.model) != "[0 40 99 100 100]" {
		t.Fatalf("model progress = %v", h.ev.model)
	}

	// The log: complete, redacted, in the target.
	targetLog := h.read(t, TargetLogPath)
	for _, s := range []string{userPW, luksPass} {
		if strings.Contains(targetLog, s) || strings.Contains(h.log.String(), s) {
			t.Fatalf("secret %q in the log", s)
		}
	}
	if !strings.Contains(targetLog, "$ cryptsetup luksFormat") || !strings.Contains(targetLog, "== bootloader") {
		t.Fatalf("log incomplete:\n%s", targetLog)
	}
}

func TestExecuteGreetdAutologinAndModelOffline(t *testing.T) {
	h := newHarness(t, false)
	eraseScript(t, h)
	put(t, h.root, "/target/etc/greetd/config.toml", packagedGreetd+"\n[initial_session]\ncommand = \"labwc\"\nuser = \"user\"\n")
	pl := erasePlan(t)
	pl.Choices.User.Autologin = true
	pl.Online = false
	Execute(context.Background(), h.deps, pl, secrets(), &Gate{})
	if h.ev.finished[0] != "true||" {
		t.Fatalf("finished = %v", h.ev.finished)
	}
	want := packagedGreetd + "\n[initial_session]\ncommand = \"labwc\"\nuser = \"ada\"\n"
	if got := h.read(t, "/target/etc/greetd/config.toml"); got != want {
		t.Fatalf("greetd\n got %q\nwant %q", got, want)
	}
	st, _ := modelstate.Read(h.fs, Target)
	if st.State != modelstate.Pending || !modelstate.IsPending(h.fs, Target) || len(h.serve.calls) != 0 {
		t.Fatalf("offline: state %+v, serve %d", st, len(h.serve.calls))
	}
}

func TestExecuteModelFailureStillInstalls(t *testing.T) {
	h := newHarness(t, true)
	eraseScript(t, h)
	Execute(context.Background(), h.deps, erasePlan(t), secrets(), &Gate{})
	if h.ev.finished[0] != "true||" {
		t.Fatalf("finished = %v", h.ev.finished)
	}
	st, _ := modelstate.Read(h.fs, Target)
	if st.State != modelstate.Pending || !modelstate.IsPending(h.fs, Target) {
		t.Fatalf("state %+v: first boot must finish the download", st)
	}
}

func TestExecuteRefusesWhenTheDiskChanged(t *testing.T) {
	h := newHarness(t, false)
	changed := strings.Replace(nvmeSgdisk, "Code  Name\n", "Code  Name\n   1            2048          206847   100.0 MiB   EF00  EFI\n", 1)
	h.run.on(execx.OK(changed), "sgdisk", "-p", "/dev/nvme0n1")
	Execute(context.Background(), h.deps, erasePlan(t), secrets(), &Gate{})
	if len(h.run.Calls) != 1 || !strings.HasPrefix(h.ev.finished[0], "false|partition|") || !strings.Contains(h.ev.finished[0], text.DiskChanged) {
		t.Fatalf("calls %d, finished %v", len(h.run.Calls), h.ev.finished)
	}
}

func TestExecuteRefusesAMountedPartitionOrStaleTarget(t *testing.T) {
	for name, mounts := range map[string]string{
		"partition mounted": "/dev/nvme0n1p1 /media/user/EFI vfat rw 0 0\n",
		"stale target":      "/dev/mapper/jarvis-root /target ext4 rw 0 0\n",
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, false)
			pl := erasePlan(t)
			pl.Disk.Partitions = []Partition{{Path: "/dev/nvme0n1p1", Number: 1}}
			put(t, h.root, "/proc/mounts", mounts)
			Execute(context.Background(), h.deps, pl, secrets(), &Gate{})
			if len(h.run.Calls) != 0 || !strings.HasPrefix(h.ev.finished[0], "false|partition|") {
				t.Fatalf("calls %v, finished %v", h.run.Calls, h.ev.finished)
			}
		})
	}
}

func TestExecuteCancelBeforeTheFirstWrite(t *testing.T) {
	h := newHarness(t, false)
	h.run.on(execx.OK(nvmeSgdisk), "sgdisk", "-p", "/dev/nvme0n1")
	g := &Gate{}
	if !g.Cancel() {
		t.Fatal("cancel before commit must be accepted")
	}
	Execute(context.Background(), h.deps, erasePlan(t), secrets(), g)
	if len(h.run.Calls) != 1 || h.ev.finished[0] != "false||"+text.Cancelled {
		t.Fatalf("calls %d finished %v", len(h.run.Calls), h.ev.finished)
	}
	g2 := &Gate{}
	g2.Commit()
	if g2.Cancel() {
		t.Fatal("cancel after the first write must be refused")
	}
}

func TestExecuteFailureCleansUp(t *testing.T) {
	h := newHarness(t, false)
	h.run.on(execx.OK(nvmeSgdisk), "sgdisk", "-p", "/dev/nvme0n1").
		ok("sgdisk", "--zap-all", "/dev/nvme0n1").
		ok("sgdisk", "--new=1:2048:1050623", "--typecode=1:ef00", "--change-name=1:EFI system partition",
			"--new=2:1050624:3147775", "--typecode=2:8300", "--change-name=2:Rafiq boot",
			"--new=3:3147776:500118158", "--typecode=3:8309", "--change-name=3:Rafiq", "/dev/nvme0n1").
		ok("partx", "-u", "/dev/nvme0n1").ok("udevadm", "settle", "--timeout=30").
		ok("wipefs", "--all", "/dev/nvme0n1p3").
		ok("cryptsetup", "luksFormat", "--type", "luks2", "--pbkdf", "argon2id", "--batch-mode", "--key-file=-", "/dev/nvme0n1p3").
		ok("cryptsetup", "open", "--type", "luks2", "--key-file=-", "/dev/nvme0n1p3", "jarvis-root").
		on(execx.Exit(1, "mkfs.ext4: Device size reported to be zero."), "mkfs.ext4", "-F", "-q", "-L", "jarvis-root", "/dev/mapper/jarvis-root").
		ok("cryptsetup", "close", "jarvis-root")
	Execute(context.Background(), h.deps, erasePlan(t), secrets(), &Gate{})
	f := h.ev.finished[0]
	if !strings.HasPrefix(f, "false|format|") || !strings.Contains(f, "FAILED in format: mkfs.ext4 -F -q -L jarvis-root /dev/mapper/jarvis-root exited with 1: mkfs.ext4: Device size reported to be zero.") ||
		!strings.Contains(f, "$ cryptsetup luksFormat") {
		t.Fatalf("finished = %q", f)
	}
	last := h.run.Calls[len(h.run.Calls)-1]
	if last.Name != "cryptsetup" || last.Args[0] != "close" {
		t.Fatalf("the LUKS mapping must be closed after a failure; last = %v", last)
	}
	if strings.Contains(f, luksPass) || strings.Contains(f, userPW) {
		t.Fatal("secret in the failure message")
	}
}

func TestExecuteNeverPutsASecretInArgv(t *testing.T) {
	h := newHarness(t, false)
	eraseScript(t, h)
	pl := erasePlan(t)
	pl.Choices.User.FullName = "hunter2-very-secret" // the password typed into the name field
	Execute(context.Background(), h.deps, pl, secrets(), &Gate{})
	if !strings.HasPrefix(h.ev.finished[0], "false|configure|") || !strings.Contains(h.ev.finished[0], "refusing to run chroot: a secret would appear in its arguments") {
		t.Fatalf("finished = %v", h.ev.finished)
	}
	for _, c := range h.run.Calls {
		if strings.Contains(strings.Join(c.Args, " "), userPW) {
			t.Fatal("the secret reached argv")
		}
	}
	if strings.Contains(h.log.String(), userPW) {
		t.Fatal("the secret reached the log")
	}
}

func TestShrinkAndCreateArgsKeepWindowsIdentity(t *testing.T) {
	pl, err := MakePlan(choices("alongside", "/dev/loop1"), probe(windowsDisk()), "p")
	if err != nil {
		t.Fatal(err)
	}
	got := shrinkArgs(*pl.Layout.Shrink, "/dev/loop1")
	want := []string{"--delete=3", "--new=3:239616:53997567", "--typecode=3:EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
		"--partition-guid=3:A73A742F-A408-4A07-88A7-C7983F8CEEE3", "--change-name=3:Basic data partition",
		"--attributes=3:=:0000000000000000", "/dev/loop1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shrink\n got %q\nwant %q", got, want)
	}
	got = createArgs(pl.Layout)
	want = []string{"--new=5:53997568:55046143", "--typecode=5:ef00", "--change-name=5:EFI system partition",
		"--new=6:55046144:57143295", "--typecode=6:8300", "--change-name=6:Rafiq boot",
		"--new=7:57143296:132120575", "--typecode=7:8309", "--change-name=7:Rafiq", "/dev/loop1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("create\n got %q\nwant %q", got, want)
	}
}

func TestExecuteAlongsidePartitionStep(t *testing.T) {
	h := newHarness(t, false)
	pl, err := MakePlan(choices("alongside", "/dev/loop1"), probe(windowsDisk()), "p")
	if err != nil {
		t.Fatal(err)
	}
	put(t, h.root, "/dev/loop1p5", "")
	put(t, h.root, "/dev/loop1p6", "")
	put(t, h.root, "/dev/loop1p7", "")
	h.run.ok("sgdisk", "--backup=/run/jarvis-installer/gpt-backup.bin", "/dev/loop1").
		ok("ntfsresize", "--no-action", "--no-progress-bar", "--size", "27524071424", "/dev/loop1p3").
		ok("ntfsresize", "--no-progress-bar", "--size", "27524071424", "/dev/loop1p3").
		ok(append([]string{"sgdisk"}, shrinkArgs(*pl.Layout.Shrink, "/dev/loop1")...)...).
		ok(append([]string{"sgdisk"}, createArgs(pl.Layout)...)...).
		ok("partx", "-u", "/dev/loop1").
		ok("udevadm", "settle", "--timeout=30")
	j := &job{d: h.deps, pl: pl, sec: secrets()}
	if err := j.partition(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(h.run.ran(), h.run.want) {
		t.Fatalf("ran %q", h.run.ran())
	}
	// ntfsresize asks "Are you sure"; only the real run gets the answer.
	if string(h.run.Calls[1].Stdin) != "" || string(h.run.Calls[2].Stdin) != "y\n" {
		t.Fatalf("stdin = %q / %q", h.run.Calls[1].Stdin, h.run.Calls[2].Stdin)
	}
}

func TestExecuteNvramFailure(t *testing.T) {
	for _, fallback := range []bool{true, false} {
		h := newHarness(t, false)
		h.run.on(execx.Exit(2, "EFI variables are not supported on this system."), "efibootmgr").
			ok("chroot", "/target", "update-grub")
		args := []string{"chroot", "/target", "grub-install", "--target=x86_64-efi", "--efi-directory=/boot/efi", "--bootloader-id=debian", "--uefi-secure-boot", "--no-nvram"}
		if fallback {
			args = append(args, "--force-extra-removable")
		}
		h.run.ok(args...)
		pl := erasePlan(t)
		pl.Layout.FallbackBoot = fallback
		err := (&job{d: h.deps, pl: pl}).bootloader(context.Background())
		if fallback && err != nil {
			t.Fatalf("erase: a missing NVRAM entry is a warning: %v", err)
		}
		if !fallback && err == nil {
			t.Fatal("alongside: without an NVRAM entry Rafiq would not start; must fail")
		}
	}
}

func TestLanKindProbe(t *testing.T) {
	ollamaSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprint(w, `{"models":[]}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer ollamaSrv.Close()
	vllm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer vllm.Close()
	j := &job{d: Deps{HTTP: http.DefaultClient, Log: NewLogger(nil, nil)}}
	if k := j.lanKind(context.Background(), ollamaSrv.URL); k != "ollama" {
		t.Errorf("ollama server: %s", k)
	}
	if k := j.lanKind(context.Background(), vllm.URL); k != "openai-compatible" {
		t.Errorf("vllm server: %s", k)
	}
	if k := j.lanKind(context.Background(), "http://127.0.0.1:1"); k != "openai-compatible" {
		t.Errorf("unreachable: %s", k)
	}
}

func TestDryRunListsTheDiskCommandsWithoutSecrets(t *testing.T) {
	pl, err := MakePlan(choices("alongside", "/dev/loop1"), probe(windowsDisk()), "p")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"sgdisk --backup=/run/jarvis-installer/gpt-backup.bin /dev/loop1",
		"ntfsresize --no-action --no-progress-bar --size 27524071424 /dev/loop1p3",
		`ntfsresize --no-progress-bar --size 27524071424 /dev/loop1p3 <<< "y\n"`,
		`sgdisk --delete=3 --new=3:239616:53997567 --typecode=3:EBD0A0A2-B9E5-4433-87C0-68B6B72699C7 --partition-guid=3:A73A742F-A408-4A07-88A7-C7983F8CEEE3 "--change-name=3:Basic data partition" --attributes=3:=:0000000000000000 /dev/loop1`,
		`sgdisk --new=5:53997568:55046143 --typecode=5:ef00 "--change-name=5:EFI system partition" --new=6:55046144:57143295 --typecode=6:8300 "--change-name=6:Rafiq boot" --new=7:57143296:132120575 --typecode=7:8309 --change-name=7:Rafiq /dev/loop1`,
		"partx -u /dev/loop1",
		"wipefs --all /dev/loop1p7",
		"cryptsetup luksFormat --type luks2 --pbkdf argon2id --batch-mode --key-file=- /dev/loop1p7 <<< <passphrase>",
		"cryptsetup open --type luks2 --key-file=- /dev/loop1p7 jarvis-root <<< <passphrase>",
		"mkfs.ext4 -F -q -L jarvis-root /dev/mapper/jarvis-root",
		"wipefs --all /dev/loop1p6",
		`mkfs.ext4 -F -q -L "Rafiq boot" /dev/loop1p6`,
		"mkfs.vfat -F 32 -n EFI /dev/loop1p5",
	}
	if got := DryRun(pl); !reflect.DeepEqual(got, want) {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
	// Manual + encryption: the table is untouched; the chosen /boot is formatted.
	c := choices("manual", "/dev/loop1")
	c.Brain = Brain{Kind: "cloud"}
	c.Disk.Manual = []ManualEntry{{"/dev/loop1p3", "/", true}, {"/dev/loop1p1", "/boot/efi", false}, {"/dev/loop1p4", "/boot", true}}
	if pl, err = MakePlan(c, probe(encryptedManualDisk()), "p"); err != nil {
		t.Fatal(err)
	}
	want = []string{
		"wipefs --all /dev/loop1p3",
		"cryptsetup luksFormat --type luks2 --pbkdf argon2id --batch-mode --key-file=- /dev/loop1p3 <<< <passphrase>",
		"cryptsetup open --type luks2 --key-file=- /dev/loop1p3 jarvis-root <<< <passphrase>",
		"mkfs.ext4 -F -q -L jarvis-root /dev/mapper/jarvis-root",
		"wipefs --all /dev/loop1p4",
		`mkfs.ext4 -F -q -L "Rafiq boot" /dev/loop1p4`,
	}
	if got := DryRun(pl); !reflect.DeepEqual(got, want) {
		t.Fatalf("manual got\n%s", strings.Join(got, "\n"))
	}
}

func TestExecuteDoneNotes(t *testing.T) {
	h := newHarness(t, false)
	eraseScript(t, h)
	pl := erasePlan(t)
	pl.SecureBoot = false
	Execute(context.Background(), h.deps, pl, secrets(), &Gate{})
	if h.ev.finished[0] != "true||"+text.NoteSecureBootOff {
		t.Fatalf("finished = %q", h.ev.finished)
	}

	h = newHarness(t, false)
	h.run.on(execx.Exit(2, "EFI variables are not supported on this system."), "efibootmgr").
		ok("chroot", "/target", "grub-install", "--target=x86_64-efi", "--efi-directory=/boot/efi", "--bootloader-id=debian", "--uefi-secure-boot", "--no-nvram", "--force-extra-removable").
		ok("chroot", "/target", "update-grub")
	pl = erasePlan(t)
	j := &job{d: h.deps, pl: pl, x: trFor(pl.Choices)}
	if err := j.bootloader(context.Background()); err != nil || len(j.notes) != 1 || j.notes[0] != text.NoteNoNVRAM {
		t.Fatalf("err %v notes %q", err, j.notes)
	}
}

func TestFailureMessageIsTheLast20RedactedLogLines(t *testing.T) {
	h := newHarness(t, false)
	h.run.on(execx.OK(nvmeSgdisk), "sgdisk", "-p", "/dev/nvme0n1").
		on(execx.Exit(4, "Problem opening /dev/nvme0n1 for writing! token=abcdef1234"), "sgdisk", "--zap-all", "/dev/nvme0n1")
	for i := 0; i < 30; i++ {
		h.deps.Log.Printf("filler %d", i)
	}
	Execute(context.Background(), h.deps, erasePlan(t), secrets(), &Gate{})
	parts := strings.SplitN(h.ev.finished[0], "|", 3)
	lines := strings.Split(parts[2], "\n")
	if parts[1] != "partition" || len(lines) != 20 || !strings.HasPrefix(lines[19], "FAILED in partition") {
		t.Fatalf("message lines = %d %q", len(lines), lines[len(lines)-1])
	}
	if strings.Contains(parts[2], "abcdef1234") {
		t.Fatal("tokens in tool output are redacted in the message too")
	}
}

// The UI offers the account password as the disk passphrase by default
// (Plan E ruling): same bytes, still stdin only.
func TestExecutePassphraseMayEqualThePassword(t *testing.T) {
	h := newHarness(t, false)
	eraseScript(t, h)
	Execute(context.Background(), h.deps, erasePlan(t), Secrets{UserPassword: luksPass, LUKSPassphrase: str(luksPass)}, &Gate{})
	if h.ev.finished[0] != "true||" {
		t.Fatalf("finished = %v", h.ev.finished)
	}
	for _, c := range h.run.Calls {
		if strings.Contains(strings.Join(c.Args, " "), luksPass) {
			t.Fatal("secret in argv")
		}
	}
	if strings.Contains(h.read(t, TargetLogPath), luksPass) {
		t.Fatal("secret in the log")
	}
}
