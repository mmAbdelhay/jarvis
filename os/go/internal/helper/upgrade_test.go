package helper

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

var dpkgArgs = []string{"-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--"}

var upgradeArgs = []string{"install", "--only-upgrade", "-y", "--no-install-recommends", "--no-remove",
	"-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "--"}

func TestAptUpgradeUpgradesOnlyInstalledNames(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.Result{Stdout: []byte("curl\t8.14.1-2\tinstalled\nvlc\t3.0\tconfig-files\n"), ExitCode: 1},
			"dpkg-query", append(dpkgArgs, "curl", "vlc", "gone")...).
		On(execx.OK(""), "apt-get", append(upgradeArgs, "curl")...)
	auth := &fakeAuth{}
	out, err := newService(run, auth).AptUpgrade(context.Background(), sender, []string{"curl", "vlc", "gone"})
	if err != nil || !out.OK {
		t.Fatalf("got %+v, %v", out, err)
	}
	if len(auth.actions) != 1 || auth.actions[0] != sender+" "+helperapi.ActionPackages {
		t.Fatalf("authorization = %v", auth.actions)
	}
	if !run.Ran("apt-get", append(upgradeArgs, "curl")...) {
		t.Fatal("only the installed package may reach apt-get")
	}
}

func TestAptUpgradeRefusals(t *testing.T) {
	// Nothing installed: NotFound, and apt-get never runs.
	run := (&execx.Fake{}).On(execx.Exit(1, "no packages found"), "dpkg-query", append(dpkgArgs, "nothere")...)
	_, err := newService(run, &fakeAuth{}).AptUpgrade(context.Background(), sender, []string{"nothere"})
	if he := helperErr(t, err); he.Name != helperapi.ErrNotFound {
		t.Fatalf("err = %v", he)
	}
	if len(run.CallsTo("apt-get")) != 0 {
		t.Fatal("apt-get ran")
	}
	// Hostile name: Invalid before authorization.
	auth := &fakeAuth{}
	_, err = newService(&execx.Fake{}, auth).AptUpgrade(context.Background(), sender, []string{"-o", "APT::Get::Remove=true"})
	if he := helperErr(t, err); he.Name != helperapi.ErrInvalid || len(auth.actions) != 0 {
		t.Fatalf("err = %v, auth = %v", he, auth.actions)
	}
	// Denied by polkit.
	_, err = newService(&execx.Fake{}, &fakeAuth{deny: true}).AptUpgrade(context.Background(), sender, []string{"curl"})
	if he := helperErr(t, err); he.Name != helperapi.ErrDenied {
		t.Fatalf("err = %v", he)
	}
}

func TestAptUpgradeRefreshesStaleListsFirst(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(""), "apt-get", "update", "-q").
		On(execx.OK("curl\t8\tinstalled\n"), "dpkg-query", append(dpkgArgs, "curl")...).
		On(execx.OK(""), "apt-get", append(upgradeArgs, "curl")...)
	s := newService(run, &fakeAuth{})
	s.ListsAge = func() (time.Duration, error) { return 7 * time.Hour, nil }
	if _, err := s.AptUpgrade(context.Background(), sender, []string{"curl"}); err != nil {
		t.Fatal(err)
	}
	if run.Calls[0].Name != "apt-get" || run.Calls[0].Args[0] != "update" {
		t.Fatalf("first call = %v", run.Calls[0])
	}
}

func TestAptUpgradeFailureIsAnOutcomeWithRedactedTail(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("curl\t8\tinstalled\n"), "dpkg-query", append(dpkgArgs, "curl")...).
		On(execx.Exit(100, "E: Failed to fetch https://user:password=hunter2@example/x\n"), "apt-get", append(upgradeArgs, "curl")...)
	out, err := newService(run, &fakeAuth{}).AptUpgrade(context.Background(), sender, []string{"curl"})
	if err != nil || out.OK || out.ExitCode != 100 || strings.Contains(out.StderrTail, "hunter2") {
		t.Fatalf("got %+v, %v", out, err)
	}
}

const vlcInfo = "VLC - The ultimate media player\n\n          ID: org.videolan.VLC\n         Ref: app/org.videolan.VLC/x86_64/stable\n      Origin: flathub\n     Version: 3.0.21\n"

func TestFlatpakUpdateFlathubAppsOnly(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(vlcInfo), "flatpak", "info", "--system", "org.videolan.VLC").
		On(execx.OK(""), "flatpak", "update", "--system", "-y", "--app", "org.videolan.VLC")
	out, err := newService(run, &fakeAuth{}).FlatpakUpdate(context.Background(), sender, []string{"org.videolan.VLC"})
	if err != nil || !out.OK {
		t.Fatalf("got %+v, %v", out, err)
	}

	other := strings.Replace(vlcInfo, "Origin: flathub", "Origin: evil-remote", 1)
	run = (&execx.Fake{}).On(execx.OK(other), "flatpak", "info", "--system", "org.videolan.VLC")
	_, err = newService(run, &fakeAuth{}).FlatpakUpdate(context.Background(), sender, []string{"org.videolan.VLC"})
	if he := helperErr(t, err); he.Name != helperapi.ErrNotAllowed {
		t.Fatalf("other remote: %v", he)
	}
	if len(run.CallsTo("flatpak")) != 1 {
		t.Fatal("flatpak update ran for a non-Flathub app")
	}

	run = (&execx.Fake{}).On(execx.Exit(1, "error: org.example.Gone/*unspecified*/* not installed"), "flatpak", "info", "--system", "org.example.Gone")
	_, err = newService(run, &fakeAuth{}).FlatpakUpdate(context.Background(), sender, []string{"org.example.Gone"})
	if he := helperErr(t, err); he.Name != helperapi.ErrNotFound {
		t.Fatalf("not installed: %v", he)
	}
}
