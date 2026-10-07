package parse

import (
	"reflect"
	"testing"
)

func TestAptSearch(t *testing.T) {
	hits := AptSearch(fixture(t, "apt-cache-search-vlc.txt"))
	if len(hits) != 30 || hits[12] != (AptSearchHit{"vlc", "multimedia player and streamer"}) {
		t.Fatalf("hits = %+v", hits)
	}
	if hits[1] != (AptSearchHit{"gem-plugin-vlc", "Graphics Environment for Multimedia - VLC support"}) {
		t.Fatalf("summary containing \" - \" = %+v", hits[1])
	}
	if len(AptSearch("")) != 0 || len(AptSearch("garbage line without separator\n")) != 0 {
		t.Fatal("non-matching lines must be skipped")
	}
}

func TestAptShow(t *testing.T) {
	pkgs := AptShow(fixture(t, "apt-cache-show.txt"))
	want := []AptPackage{
		{Name: "vlc", Version: "3.0.24-0+deb13u1", Summary: "multimedia player and streamer", DownloadBytes: 114728, InstalledBytes: 204 * 1024},
		{Name: "vlc-bin", Version: "3.0.24-0+deb13u1", Summary: "binaries from VLC", DownloadBytes: 132428, InstalledBytes: 357 * 1024},
	}
	if !reflect.DeepEqual(pkgs, want) {
		t.Fatalf("got %+v\nwant %+v", pkgs, want)
	}
}

func TestAptShowTranslatedDescriptionKeyAndDuplicateStanzas(t *testing.T) {
	// Description-en appears when apt has Translation-en indices.
	out := "Package: hello\nVersion: 2.10-3\nDescription-en: example package\n more\n\nPackage: hello\nVersion: 2.9-1\nDescription: old\n"
	pkgs := AptShow(out)
	if len(pkgs) != 1 || pkgs[0].Version != "2.10-3" || pkgs[0].Summary != "example package" {
		t.Fatalf("got %+v", pkgs)
	}
}

func TestDpkgSearch(t *testing.T) {
	out := "vlc-bin, vlc:amd64: /usr/share/applications/vlc.desktop\n" +
		"diversion by foo from: /usr/share/applications/x.desktop\n" +
		"gimp: /usr/share/applications/gimp.desktop\n"
	got := DpkgSearch(out)
	if !reflect.DeepEqual(got["/usr/share/applications/vlc.desktop"], []string{"vlc-bin", "vlc"}) {
		t.Fatalf("vlc owners = %v", got["/usr/share/applications/vlc.desktop"])
	}
	if !reflect.DeepEqual(got["/usr/share/applications/gimp.desktop"], []string{"gimp"}) || len(got) != 2 {
		t.Fatalf("got %v", got)
	}
}

func TestDpkgQuery(t *testing.T) {
	out := "vlc\t3.0.21-10\tinstalled\ngimp\t3.0.4-1\tconfig-files\n\nbroken line\n"
	got := DpkgQuery(out)
	want := []DpkgStatus{{"vlc", "3.0.21-10", true}, {"gimp", "3.0.4-1", false}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestAptSimulatedRemovals(t *testing.T) {
	out := "Reading package lists...\nThe following packages will be REMOVED:\n  jarvis-shell qt6-base\nRemv jarvis-shell [0.1.0]\nRemv libqt6core6t64 [6.8.2+dfsg-5]\n"
	if got := AptSimulatedRemovals(out); !reflect.DeepEqual(got, []string{"jarvis-shell", "libqt6core6t64"}) {
		t.Fatalf("got %v", got)
	}
}

func TestFlatpakSearch(t *testing.T) {
	out := "com.spotify.Client\tSpotify\t1.2.47.364.gf06e5b9b\tOnline music streaming service\tflathub\n" +
		"io.github.spotdl.spotdl\tspotDL\t4.2.5\tDownload your Spotify playlists\tflathub,flathub-beta\n"
	got := FlatpakSearch(out)
	if len(got) != 2 || got[0].ID != "com.spotify.Client" || got[0].Name != "Spotify" || got[1].Remotes[1] != "flathub-beta" {
		t.Fatalf("got %+v", got)
	}
	if len(FlatpakSearch("No matches found\n")) != 0 {
		t.Fatal("no-match message must yield no rows")
	}
}

func TestFlatpakList(t *testing.T) {
	got := FlatpakList("com.spotify.Client\tSpotify\t1.2.47.364.gf06e5b9b\norg.gimp.GIMP\tGNU Image Manipulation Program\t3.0.4\n")
	if len(got) != 2 || got[1] != (FlatpakApp{"org.gimp.GIMP", "GNU Image Manipulation Program", "3.0.4"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestFlatpakDetailsRemoteInfo(t *testing.T) {
	info, err := FlatpakDetails(fixture(t, "flatpak-remote-info.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want := FlatpakInfo{ID: "org.videolan.VLC", Name: "VLC", Version: "3.0.23",
		Summary: "VLC media player, the open-source multimedia player", DownloadBytes: 52_700_000, InstalledBytes: 139_400_000}
	if info != want {
		t.Fatalf("got %+v\nwant %+v", info, want)
	}
}

func TestFlatpakDetailsInstalledInfo(t *testing.T) {
	info, err := FlatpakDetails(fixture(t, "flatpak-info-spotify.txt"))
	if err != nil || info.ID != "com.spotify.Client" || info.Version != "1.2.47.364.gf06e5b9b" || info.InstalledBytes != 6_100_000 {
		t.Fatalf("got %+v, %v", info, err)
	}
	if _, err := FlatpakDetails("error: Nothing matches org.nope.App\n"); err == nil {
		t.Fatal("output without ID must be an error")
	}
}

func TestHumanSize(t *testing.T) {
	for in, want := range map[string]int64{"37.4 MB": 37_400_000, "980 bytes": 980, "1.2 GB": 1_200_000_000, "512 kB": 512_000} {
		if got, err := HumanSize(in); err != nil || got != want {
			t.Errorf("HumanSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, err := HumanSize("lots"); err == nil {
		t.Error("garbage accepted")
	}
}

func TestDesktop(t *testing.T) {
	e := Desktop(fixture(t, "vlc.desktop"))
	if e.Name != "VLC media player" || !e.Visible() {
		t.Fatalf("got %+v", e)
	}
	if Desktop("[Desktop Entry]\nName=X\nType=Application\nNoDisplay=true\n").Visible() {
		t.Fatal("NoDisplay entry must be hidden")
	}
	if Desktop("[Desktop Action x]\nName=Play\n").Name != "" {
		t.Fatal("action group leaked into entry")
	}
}
