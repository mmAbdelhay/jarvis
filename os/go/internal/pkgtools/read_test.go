package pkgtools

import (
	"testing"
	"testing/fstest"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

const flatpakSearchCols = "--columns=application,name,version,description,remotes"

func TestSearchMergesAndPrefersAptOnExactMatch(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("vlc - multimedia player and streamer\nlibvlc5 - multimedia player library\nvlc-bin - binaries from VLC\n"), "apt-cache", "search", "--", "vlc").
		On(execx.OK("Package: vlc\nVersion: 3.0.21-10\n\nPackage: vlc-bin\nVersion: 3.0.21-10\n\nPackage: libvlc5\nVersion: 3.0.21-10\n"), "apt-cache", "show", "--no-all-versions", "--", "vlc", "vlc-bin", "libvlc5").
		On(execx.OK("org.videolan.VLC\tVLC\t3.0.21\tVLC media player\tflathub\nio.evil.App\tVLC\t1\tfake\tevilremote\n"), "flatpak", "search", flatpakSearchCols, "--", "VLC")
	v, err := call(t, Deps{Run: run}, "pkg.search", `{"query":"VLC"}`)
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, v)["results"].([]any)
	if len(res) != 4 {
		t.Fatalf("results = %v", res)
	}
	first, second := res[0].(map[string]any), res[1].(map[string]any)
	if first["source"] != "apt" || first["id"] != "vlc" || first["version"] != "3.0.21-10" {
		t.Errorf("first = %v, want apt vlc", first)
	}
	if second["source"] != "flatpak" || second["id"] != "org.videolan.VLC" {
		t.Errorf("second = %v, want the Flathub exact match", second)
	}
	for _, r := range res {
		if r.(map[string]any)["id"] == "io.evil.App" {
			t.Error("a non-Flathub remote leaked into results")
		}
	}
}

func TestSearchQuotesRegexAndCannotInjectOptions(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(""), "apt-cache", "search", "--", `-o`, `c\+\+`).
		On(execx.OK("No matches found\n"), "flatpak", "search", flatpakSearchCols, "--", "-o c++")
	v, err := call(t, Deps{Run: run}, "pkg.search", `{"query":"-o c++"}`)
	if err != nil {
		t.Fatal(err)
	}
	if res := asJSON(t, v)["results"].([]any); len(res) != 0 {
		t.Fatalf("results = %v", res)
	}
}

func TestSearchWorksWithoutFlatpak(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("hello - example package\n"), "apt-cache", "search", "--", "hello").
		On(execx.OK("Package: hello\nVersion: 2.10-3\n"), "apt-cache", "show", "--no-all-versions", "--", "hello")
	// flatpak not registered: the fake returns "unexpected command", like a missing binary.
	v, err := call(t, Deps{Run: run}, "pkg.search", `{"query":"hello","limit":5}`)
	if err != nil || len(asJSON(t, v)["results"].([]any)) != 1 {
		t.Fatalf("got %v, %v", v, err)
	}
}

func TestSearchRejectsBadInput(t *testing.T) {
	for _, args := range []string{`{}`, `{"query":""}`, `{"query":"   "}`, `{"query":"a\u0000b"}`, `{"query":"x","limit":0}`, `{"query":"x","limit":51}`, `{"query":"x","extra":1}`} {
		if _, err := call(t, Deps{Run: &execx.Fake{}}, "pkg.search", args); code(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v, want invalid", args, err)
		}
	}
}

func TestInfoApt(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Package: vlc\nVersion: 3.0.21-10\nInstalled-Size: 293\nSize: 48356\nDescription-en: multimedia player and streamer\n"), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", dpkgFormat, "--", "vlc")
	v, err := call(t, Deps{Run: run}, "pkg.info", `{"source":"apt","id":"vlc"}`)
	if err != nil {
		t.Fatal(err)
	}
	got := v.(Info)
	if got.Version != "3.0.21-10" || got.DownloadBytes != 48356 || got.InstalledBytes != 293*1024 || !got.Installed || got.Summary != "multimedia player and streamer" {
		t.Fatalf("got %+v", got)
	}
}

func TestInfoFlatpakOfflineAndNotFound(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.Exit(1, "error: Unable to load summary from remote flathub: Could not resolve hostname"), "flatpak", "remote-info", "--system", "flathub", "com.spotify.Client").
		On(execx.Exit(1, "error: No remote refs found for 'org.nope.App'"), "flatpak", "remote-info", "--system", "flathub", "org.nope.App")
	if _, err := call(t, Deps{Run: run}, "pkg.info", `{"source":"flatpak","id":"com.spotify.Client"}`); code(err) != mcp.CodeOffline {
		t.Errorf("offline: %v", err)
	}
	if _, err := call(t, Deps{Run: run}, "pkg.info", `{"source":"flatpak","id":"org.nope.App"}`); code(err) != mcp.CodeNotFound {
		t.Errorf("not found: %v", err)
	}
	if _, err := call(t, Deps{Run: run}, "pkg.info", `{"source":"snap","id":"vlc"}`); code(err) != mcp.CodeInvalid {
		t.Errorf("bad source: %v", err)
	}
}

func TestListInstalled(t *testing.T) {
	fsys := fstest.MapFS{
		"usr/share/applications/vlc.desktop":    {Data: []byte("[Desktop Entry]\nName=VLC media player\nType=Application\n")},
		"usr/share/applications/hidden.desktop": {Data: []byte("[Desktop Entry]\nName=Hidden\nType=Application\nNoDisplay=true\n")},
		"usr/share/applications/orphan.desktop": {Data: []byte("[Desktop Entry]\nName=Orphan\nType=Application\n")},
	}
	run := (&execx.Fake{}).
		On(execx.Result{ExitCode: 1, Stdout: []byte("vlc: /usr/share/applications/vlc.desktop\n"), Stderr: []byte("dpkg-query: no path found matching pattern /usr/share/applications/orphan.desktop\n")},
			"dpkg-query", "-S", "--", "/usr/share/applications/orphan.desktop", "/usr/share/applications/vlc.desktop").
		On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", dpkgFormat, "--", "vlc").
		On(execx.OK("com.spotify.Client\tSpotify\t1.2.47\n"), "flatpak", "list", "--app", "--columns=application,name,version")
	v, err := call(t, Deps{Run: run, FS: fsys}, "pkg.list_installed", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	apps := v.(map[string]any)["apps"].([]App)
	want := []App{{"flatpak", "com.spotify.Client", "Spotify", "1.2.47"}, {"apt", "vlc", "VLC media player", "3.0.21-10"}}
	if len(apps) != 2 || apps[0] != want[0] || apps[1] != want[1] {
		t.Fatalf("apps = %+v", apps)
	}
}

func TestDiskUsage(t *testing.T) {
	fsys := fstest.MapFS{"home/jarvis/Videos/a.mp4": {Data: []byte("x")}}
	run := (&execx.Fake{}).
		On(execx.OK("Mounted on 1B-blocks Used\n/ 4123459584 987654144\n"), "df", "-B1", "--output=target,size,used", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "efivarfs").
		On(execx.Result{ExitCode: 1, Stdout: []byte("1073741824\t/home/jarvis/Videos\n1073745920\t/home/jarvis\n")}, "du", "-x", "-B1", "-d", "1", "--", "/home/jarvis")
	v, err := call(t, Deps{Run: run, FS: fsys, Home: "/home/jarvis"}, "disk.usage", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	if len(m["filesystems"].([]any)) != 1 || m["largest"].([]any)[0].(map[string]any)["path"] != "/home/jarvis/Videos" {
		t.Fatalf("got %v", m)
	}
	for _, args := range []string{`{"path":"relative/dir"}`, `{"path":"/no/such/dir"}`} {
		if _, err := call(t, Deps{Run: run, FS: fsys, Home: "/home/jarvis"}, "disk.usage", args); err == nil {
			t.Errorf("%s accepted", args)
		}
	}
}
