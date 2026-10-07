package helper

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

const sender = ":1.42"

type fakeAuth struct {
	mu      sync.Mutex
	deny    bool
	actions []string
}

func (a *fakeAuth) Authorize(_ context.Context, s, action string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.actions = append(a.actions, s+" "+action)
	if a.deny {
		return ErrDenied
	}
	return nil
}

func newService(run *execx.Fake, auth *fakeAuth) *Service {
	return &Service{
		Run: run, Auth: auth,
		Now:      func() time.Time { return time.Unix(1_800_000_000, 0) },
		ListsAge: func() (time.Duration, error) { return time.Hour, nil }, // fresh
	}
}

func helperErr(t *testing.T, err error) *helperapi.Error {
	t.Helper()
	var he *helperapi.Error
	if !errors.As(err, &he) {
		t.Fatalf("err = %v, want *helperapi.Error", err)
	}
	return he
}

const vlcShow = "Package: vlc\nVersion: 3.0.21-10\nDescription-en: multimedia player and streamer\n"

func TestAptInstallHappyPath(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(vlcShow), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.Result{Stderr: []byte("W: something harmless\n")}, "apt-get", "install", "-y", "--no-install-recommends", "--", "vlc")
	auth := &fakeAuth{}
	out, err := newService(run, auth).AptInstall(context.Background(), sender, []string{"vlc"})
	if err != nil || !out.OK || out.ExitCode != 0 || out.StderrTail != "W: something harmless\n" {
		t.Fatalf("got %+v, %v", out, err)
	}
	if len(auth.actions) != 1 || auth.actions[0] != sender+" "+helperapi.ActionPackages {
		t.Fatalf("authorization = %v", auth.actions)
	}
	if run.Ran("apt-get", "update", "-q") {
		t.Fatal("fresh lists must not be refreshed")
	}
}

func TestAptInstallRefreshesStaleLists(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(""), "apt-get", "update", "-q").
		On(execx.OK(vlcShow), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.OK(""), "apt-get", "install", "-y", "--no-install-recommends", "--", "vlc")
	s := newService(run, &fakeAuth{})
	s.ListsAge = func() (time.Duration, error) { return 0, ErrNoLists }
	if _, err := s.AptInstall(context.Background(), sender, []string{"vlc"}); err != nil {
		t.Fatal(err)
	}
	if !run.Ran("apt-get", "update", "-q") {
		t.Fatal("stale lists were not refreshed")
	}
}

func TestHostileNamesNeverReachARunnerOrPolkit(t *testing.T) {
	ctx := context.Background()
	for _, names := range [][]string{{"vlc; rm -rf /"}, {"-o", "APT::Get::Trivial-Only=true"}, {"../"}, {""}, {"vlс"}, {}} {
		run, auth := &execx.Fake{}, &fakeAuth{}
		s := newService(run, auth)
		for name, call := range map[string]func() (helperapi.Outcome, error){
			"AptInstall": func() (helperapi.Outcome, error) { return s.AptInstall(ctx, sender, names) },
			"AptRemove":  func() (helperapi.Outcome, error) { return s.AptRemove(ctx, sender, names) },
		} {
			_, err := call()
			if helperErr(t, err).Name != helperapi.ErrInvalid {
				t.Errorf("%s(%q): %v", name, names, err)
			}
		}
		if len(run.Calls) != 0 || len(auth.actions) != 0 {
			t.Errorf("%q reached runner %v / polkit %v", names, run.Calls, auth.actions)
		}
	}
	for _, refs := range [][]string{{"--from=https://evil.example/x.flatpakref"}, {"fedora:org.gnome.Calculator"}, {"org.videolan.VLC;reboot"}} {
		run := &execx.Fake{}
		s := newService(run, &fakeAuth{})
		if _, err := s.FlatpakInstall(ctx, sender, refs); helperErr(t, err).Name != helperapi.ErrInvalid {
			t.Errorf("FlatpakInstall(%q): %v", refs, err)
		}
		if len(run.Calls) != 0 {
			t.Errorf("%q reached the runner", refs)
		}
	}
}

func TestDeniedCallerRunsNothing(t *testing.T) {
	run := &execx.Fake{}
	_, err := newService(run, &fakeAuth{deny: true}).AptInstall(context.Background(), sender, []string{"vlc"})
	if helperErr(t, err).Name != helperapi.ErrDenied || len(run.Calls) != 0 {
		t.Fatalf("err=%v calls=%v", err, run.Calls)
	}
}

func TestAptInstallUnknownPackageIsNotFound(t *testing.T) {
	run := (&execx.Fake{}).On(execx.Exit(100, "E: No packages found\n"), "apt-cache", "show", "--no-all-versions", "--", "nosuchpkg")
	_, err := newService(run, &fakeAuth{}).AptInstall(context.Background(), sender, []string{"nosuchpkg"})
	if helperErr(t, err).Name != helperapi.ErrNotFound {
		t.Fatalf("err = %v", err)
	}
	if run.Ran("apt-get", "install", "-y", "--no-install-recommends", "--", "nosuchpkg") {
		t.Fatal("install ran for a package that does not exist")
	}
}

func TestFailedRunReturnsRedactedStderrTail(t *testing.T) {
	long := strings.Repeat("x", 6000) + "\nE: auth failed password=hunter2\n"
	run := (&execx.Fake{}).
		On(execx.OK(vlcShow), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.Exit(100, long), "apt-get", "install", "-y", "--no-install-recommends", "--", "vlc")
	out, err := newService(run, &fakeAuth{}).AptInstall(context.Background(), sender, []string{"vlc"})
	if err != nil || out.OK || out.ExitCode != 100 {
		t.Fatalf("got %+v, %v", out, err)
	}
	if len(out.StderrTail) > helperapi.StderrTailMax || !strings.HasSuffix(out.StderrTail, "password=[redacted:secret]\n") {
		t.Fatalf("tail len %d, ends %q", len(out.StderrTail), out.StderrTail[len(out.StderrTail)-40:])
	}
}

func TestAptRemoveRefusesToTakeProtectedPackages(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("qt6-base-dev\t6.8.2\tinstalled\n"), "dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--", "qt6-base-dev").
		On(execx.OK("Remv jarvis-shell [0.1.0]\nRemv qt6-base-dev [6.8.2]\n"), "apt-get", "-s", "remove", "--", "qt6-base-dev")
	_, err := newService(run, &fakeAuth{}).AptRemove(context.Background(), sender, []string{"qt6-base-dev"})
	he := helperErr(t, err)
	if he.Name != helperapi.ErrNotAllowed || !strings.Contains(he.Message, "jarvis-shell") {
		t.Fatalf("err = %v", err)
	}
	if run.Ran("apt-get", "remove", "-y", "--", "qt6-base-dev") {
		t.Fatal("removal ran")
	}
}

func TestAptRemoveHappyPathAndNotInstalled(t *testing.T) {
	q := "-f=${Package}\t${Version}\t${db:Status-Status}\n"
	run := (&execx.Fake{}).
		On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", q, "--", "vlc").
		On(execx.OK("Remv vlc [3.0.21-10]\n"), "apt-get", "-s", "remove", "--", "vlc").
		On(execx.OK(""), "apt-get", "remove", "-y", "--", "vlc").
		On(execx.Exit(1, "dpkg-query: no packages found matching gimp\n"), "dpkg-query", "-W", q, "--", "gimp")
	s := newService(run, &fakeAuth{})
	if out, err := s.AptRemove(context.Background(), sender, []string{"vlc"}); err != nil || !out.OK {
		t.Fatalf("remove vlc: %+v %v", out, err)
	}
	if _, err := s.AptRemove(context.Background(), sender, []string{"gimp"}); helperErr(t, err).Name != helperapi.ErrNotFound {
		t.Fatalf("remove gimp: %v", err)
	}
}

func TestFlatpakInstallUsesFlathubOnly(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("ID: com.spotify.Client\n"), "flatpak", "remote-info", "--system", "flathub", "com.spotify.Client").
		On(execx.OK(""), "flatpak", "install", "--system", "-y", "flathub", "com.spotify.Client")
	out, err := newService(run, &fakeAuth{}).FlatpakInstall(context.Background(), sender, []string{"com.spotify.Client"})
	if err != nil || !out.OK {
		t.Fatalf("got %+v %v", out, err)
	}
}

func TestFlatpakInstallOfflineIsAFailedRunNotNotFound(t *testing.T) {
	run := (&execx.Fake{}).On(execx.Exit(1, "error: Unable to load summary from remote flathub: Could not resolve hostname\n"), "flatpak", "remote-info", "--system", "flathub", "com.spotify.Client")
	out, err := newService(run, &fakeAuth{}).FlatpakInstall(context.Background(), sender, []string{"com.spotify.Client"})
	if err != nil || out.OK || !helperapi.LooksOffline(out.StderrTail) {
		t.Fatalf("got %+v %v", out, err)
	}
}

func TestFlatpakRemove(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("ID: com.spotify.Client\n"), "flatpak", "info", "--system", "com.spotify.Client").
		On(execx.OK(""), "flatpak", "uninstall", "--system", "-y", "com.spotify.Client")
	if out, err := newService(run, &fakeAuth{}).FlatpakRemove(context.Background(), sender, []string{"com.spotify.Client"}); err != nil || !out.OK {
		t.Fatalf("got %+v %v", out, err)
	}
}

func TestRestartUnit(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("loaded\n"), "systemctl", "show", "-p", "LoadState", "--value", "--", "NetworkManager.service").
		On(execx.OK(""), "systemctl", "restart", "--", "NetworkManager.service").
		On(execx.OK("not-found\n"), "systemctl", "show", "-p", "LoadState", "--value", "--", "docker.service")
	auth := &fakeAuth{}
	s := newService(run, auth)
	if out, err := s.RestartUnit(context.Background(), sender, "NetworkManager"); err != nil || !out.OK {
		t.Fatalf("restart NM: %+v %v", out, err)
	}
	if auth.actions[0] != sender+" "+helperapi.ActionServices {
		t.Fatalf("wrong polkit action: %v", auth.actions)
	}
	if _, err := s.RestartUnit(context.Background(), sender, "docker"); helperErr(t, err).Name != helperapi.ErrNotFound {
		t.Fatalf("docker: %v", err)
	}
	if _, err := s.RestartUnit(context.Background(), sender, "sshd"); helperErr(t, err).Name != helperapi.ErrNotAllowed {
		t.Fatalf("sshd: %v", err)
	}
	if _, err := s.RestartUnit(context.Background(), sender, "NetworkManager; reboot"); helperErr(t, err).Name != helperapi.ErrInvalid {
		t.Fatalf("injection: %v", err)
	}
}

// blockingRunner holds every apt-get install until released, counting how
// many run at once.
type blockingRunner struct {
	execx.Fake
	release       chan struct{}
	mu            sync.Mutex
	running, peak int
}

func (b *blockingRunner) Run(ctx context.Context, c execx.Cmd) (execx.Result, error) {
	if c.Name == "apt-get" {
		b.mu.Lock()
		b.running++
		if b.running > b.peak {
			b.peak = b.running
		}
		b.mu.Unlock()
		<-b.release
		b.mu.Lock()
		b.running--
		b.mu.Unlock()
	}
	return b.Fake.Run(ctx, c)
}

func TestOperationsAreSerialised(t *testing.T) {
	br := &blockingRunner{release: make(chan struct{})}
	for _, n := range []string{"vlc", "gimp"} {
		br.On(execx.OK("Package: "+n+"\nVersion: 1\n"), "apt-cache", "show", "--no-all-versions", "--", n)
		br.On(execx.OK(""), "apt-get", "install", "-y", "--no-install-recommends", "--", n)
	}
	s := &Service{Run: br, Auth: &fakeAuth{}, Now: time.Now, ListsAge: func() (time.Duration, error) { return 0, nil }}
	var wg sync.WaitGroup
	for _, n := range []string{"vlc", "gimp"} {
		wg.Add(1)
		go func(n string) { defer wg.Done(); s.AptInstall(context.Background(), sender, []string{n}) }(n)
	}
	time.Sleep(50 * time.Millisecond)
	if s.IdleFor(time.Now()) != 0 {
		t.Error("service reported idle while busy")
	}
	close(br.release)
	wg.Wait()
	if br.peak != 1 {
		t.Fatalf("%d apt-get processes ran at once, want 1", br.peak)
	}
}

func TestAptListsAge(t *testing.T) {
	built := time.Unix(1_800_000_000, 0)
	now := func() time.Time { return built.Add(7 * time.Hour) }
	lists := fstest.MapFS{
		"lock":      {ModTime: now()},
		"partial/x": {ModTime: now()},
		"deb.debian.org_debian_dists_trixie_InRelease":                      {ModTime: built},
		"deb.debian.org_debian_dists_trixie_main_binary-amd64_Packages.lz4": {ModTime: built.Add(-time.Hour)},
	}
	if age, err := AptListsAge(lists, now)(); err != nil || age != 7*time.Hour {
		t.Fatalf("age = %v, %v; want 7h from the newest index, ignoring lock and partial/", age, err)
	}
	empty := fstest.MapFS{"lock": {ModTime: now()}, "partial/x": {ModTime: now()}}
	if _, err := AptListsAge(empty, now)(); !errors.Is(err, ErrNoLists) {
		t.Fatalf("empty lists: err = %v, want ErrNoLists", err)
	}
}

// contracts §6.4: apt-get update runs first when the lists are older than
// 6 hours or empty, and not otherwise.
func TestAptInstallRefreshDecision(t *testing.T) {
	built := time.Unix(1_800_000_000, 0)
	index := "deb.debian.org_debian_dists_trixie_InRelease"
	for name, c := range map[string]struct {
		lists   fstest.MapFS
		refresh bool
	}{
		"5h old": {fstest.MapFS{index: {ModTime: built.Add(-5 * time.Hour)}}, false},
		"7h old": {fstest.MapFS{index: {ModTime: built.Add(-7 * time.Hour)}}, true},
		"empty":  {fstest.MapFS{"lock": {ModTime: built}}, true},
	} {
		run := (&execx.Fake{}).
			On(execx.OK(""), "apt-get", "update", "-q").
			On(execx.OK(vlcShow), "apt-cache", "show", "--no-all-versions", "--", "vlc").
			On(execx.OK(""), "apt-get", "install", "-y", "--no-install-recommends", "--", "vlc")
		s := newService(run, &fakeAuth{})
		s.ListsAge = AptListsAge(c.lists, func() time.Time { return built })
		if _, err := s.AptInstall(context.Background(), sender, []string{"vlc"}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := run.Ran("apt-get", "update", "-q"); got != c.refresh {
			t.Errorf("%s: apt-get update ran = %v, want %v", name, got, c.refresh)
		}
		if c.refresh && run.Calls[0].Name != "apt-get" {
			t.Errorf("%s: update must run before anything else, ran %v first", name, run.Calls[0])
		}
	}
}
