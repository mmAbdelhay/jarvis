package parse

import (
	"reflect"
	"testing"
)

func TestAptSimUpgrade(t *testing.T) {
	ups := AptSimUpgrade(fixture(t, "apt-get-s-upgrade.txt"))
	if len(ups) != 62 {
		t.Fatalf("got %d upgrades, want 62", len(ups))
	}
	sec := 0
	byName := map[string]AptUpgrade{}
	for _, u := range ups {
		byName[u.Name] = u
		if u.Security {
			sec++
		}
	}
	if sec != 26 {
		t.Errorf("security = %d, want 26", sec)
	}
	if u := byName["linux-libc-dev"]; u != (AptUpgrade{"linux-libc-dev", "6.12.63-1", "6.12.111-1", true}) {
		t.Errorf("linux-libc-dev = %+v", u)
	}
	if u := byName["libc6"]; u.Security || u.From != "2.41-12+deb13u1" || u.To != "2.41-12+deb13u4" {
		t.Errorf("libc6 = %+v", u)
	}
	if u := byName["bsdutils"]; !u.Security || u.From != "1:2.41-5" {
		t.Errorf("bsdutils (two origins) = %+v", u)
	}
}

func TestAptCachePolicy(t *testing.T) {
	got := AptCachePolicy(fixture(t, "apt-cache-policy.txt"))
	want := []AptPolicy{
		{Name: "linux-libc-dev", Installed: "6.12.63-1", Candidate: "6.12.111-1", CandidateSecurity: true},
		{Name: "curl", Installed: "8.14.1-2+deb13u2", Candidate: "8.14.1-2+deb13u5"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	none := AptCachePolicy("foo:\n  Installed: (none)\n  Candidate: 1.0\n  Version table:\n     1.0 500\n        500 http://deb.debian.org/debian trixie/main amd64 Packages\n")
	if len(none) != 1 || none[0].Installed != "" || none[0].Candidate != "1.0" || none[0].CandidateSecurity {
		t.Fatalf("none = %+v", none)
	}
}

func TestTabRows(t *testing.T) {
	rows := TabRows(fixture(t, "flatpak-remote-ls-updates.txt"), 3)
	if len(rows) != 3 || !reflect.DeepEqual(rows[0], []string{"org.videolan.VLC", "3.0.22", "flathub"}) {
		t.Fatalf("rows = %v", rows)
	}
}
