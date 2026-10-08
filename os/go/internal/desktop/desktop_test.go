package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const firefox = `[Desktop Entry]
Version=1.0
Name=Firefox ESR
Name[ar]=فَيَرفُكس
Exec=/usr/lib/firefox-esr/firefox-esr %u
Icon=firefox-esr
Terminal=false
Type=Application
MimeType=text/html;text/xml;x-scheme-handler/http;x-scheme-handler/https;
Categories=Network;WebBrowser;
Keywords=web\;browser;internet;
StartupWMClass=firefox-esr

[Desktop Action new-window]
Name=New Window
Exec=/usr/lib/firefox-esr/firefox-esr --new-window %u
`

func TestParse(t *testing.T) {
	e := Parse(firefox)
	if e.Name != "Firefox ESR" || e.NameAr != "فَيَرفُكس" || e.Exec != "/usr/lib/firefox-esr/firefox-esr %u" || e.Icon != "firefox-esr" || e.StartupWMClass != "firefox-esr" {
		t.Fatalf("entry %+v", e)
	}
	if !reflect.DeepEqual(e.MimeTypes, []string{"text/html", "text/xml", "x-scheme-handler/http", "x-scheme-handler/https"}) {
		t.Fatalf("mime %v", e.MimeTypes)
	}
	if !reflect.DeepEqual(e.Keywords, []string{"web;browser", "internet"}) || !reflect.DeepEqual(e.Categories, []string{"Network", "WebBrowser"}) {
		t.Fatalf("lists %v %v", e.Keywords, e.Categories)
	}
	if !e.Visible() {
		t.Fatal("visible")
	}
	for _, hidden := range []string{"[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true\n", "[Desktop Entry]\nType=Link\nName=X\nExec=x\n", "[Desktop Entry]\nType=Application\nName=X\n"} {
		if Parse(hidden).Visible() {
			t.Errorf("must not be visible:\n%s", hidden)
		}
	}
}

func write(t *testing.T, dir, rel, data string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIndexPrecedenceAndIDs(t *testing.T) {
	user, flat, sys := t.TempDir(), t.TempDir(), t.TempDir()
	app := func(name string) string {
		return "[Desktop Entry]\nType=Application\nName=" + name + "\nExec=" + name + "\n"
	}
	write(t, sys, "firefox-esr.desktop", firefox)
	write(t, sys, "vlc.desktop", app("VLC media player"))
	write(t, sys, "kde/okular.desktop", app("Okular"))
	write(t, sys, "huge.desktop", string(make([]byte, 300<<10)))
	write(t, flat, "org.gnome.Calculator.desktop", app("Calculator"))
	write(t, user, "vlc.desktop", "[Desktop Entry]\nType=Application\nName=VLC\nExec=vlc\nHidden=true\n")
	got := Index([]Dir{{user, "user"}, {flat, "flatpak"}, {filepath.Join(sys, "missing"), "apt"}, {sys, "apt"}})
	var ids []string
	for _, e := range got {
		ids = append(ids, e.ID+"/"+e.Source)
	}
	want := []string{"org.gnome.Calculator/flatpak", "firefox-esr/apt", "kde-okular/apt"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("index %v, want %v (user Hidden=true hides vlc)", ids, want)
	}
	if got := DefaultDirs("/home/u"); got[0].Path != "/home/u/.local/share/applications" || got[2].Path != "/var/lib/flatpak/exports/share/applications" {
		t.Fatalf("default dirs %v", got)
	}
}

func TestExpandExec(t *testing.T) {
	e := Entry{Name: "My App", Icon: "myapp", Path: "/usr/share/applications/my.desktop"}
	for _, c := range []struct {
		exec    string
		targets []string
		want    []string
	}{
		{"/usr/bin/code --unity-launch %F", []string{"/home/u/proj", "/home/u/b c.txt"}, []string{"/usr/bin/code", "--unity-launch", "/home/u/proj", "/home/u/b c.txt"}},
		{"/usr/bin/code --unity-launch %F", nil, []string{"/usr/bin/code", "--unity-launch"}},
		{"firefox-esr %u", []string{"https://example.org"}, []string{"firefox-esr", "https://example.org"}},
		{"firefox-esr %u", nil, []string{"firefox-esr"}},
		{`/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=gnome-calculator org.gnome.Calculator`, nil, []string{"/usr/bin/flatpak", "run", "--branch=stable", "--arch=x86_64", "--command=gnome-calculator", "org.gnome.Calculator"}},
		{`sh -c "echo \"hi\" \\$HOME"`, nil, []string{"sh", "-c", `echo "hi" $HOME`}},
		{"app --name=%c %i --file=%f %k 100%%", []string{"/tmp/x"}, []string{"app", "--name=My App", "--icon", "myapp", "--file=/tmp/x", "/usr/share/applications/my.desktop", "100%"}},
		{"app %d %D %n %N %v %m", nil, []string{"app"}},
		{`"my\sapp" arg`, nil, []string{"my app", "arg"}},
		{`my\sapp arg`, nil, []string{"my", "app", "arg"}},
	} {
		e.Exec = c.exec
		got, err := ExpandExec(e, c.targets)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q %v: %q %v, want %q", c.exec, c.targets, got, err, c.want)
		}
	}
	for _, bad := range []string{`app "unterminated`, "app %x", "app --x=%F", "", "%f"} {
		e.Exec = bad
		if _, err := ExpandExec(e, nil); !errors.Is(err, ErrBadExec) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	e.Exec = "gnome-calculator"
	if _, err := ExpandExec(e, []string{"/home/u/a.txt"}); !errors.Is(err, ErrNoFiles) {
		t.Errorf("no file code: %v", err)
	}
}
