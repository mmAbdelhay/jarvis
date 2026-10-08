package homepath

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

// tree builds a home with private corners, an outside folder and links.
func tree(t *testing.T) (home, outside string) {
	home, outside = t.TempDir(), t.TempDir()
	must(t, os.MkdirAll(filepath.Join(home, "Documents", "Work"), 0o755))
	must(t, os.MkdirAll(filepath.Join(home, ".ssh"), 0o700))
	must(t, os.WriteFile(filepath.Join(home, "Documents", "a.txt"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(home, ".ssh", "id_rsa"), []byte("k"), 0o600))
	must(t, os.WriteFile(filepath.Join(outside, "x.txt"), []byte("x"), 0o644))
	must(t, os.Symlink(filepath.Join(home, "Documents"), filepath.Join(home, "Docs")))
	must(t, os.Symlink(outside, filepath.Join(home, "Out")))
	must(t, os.Symlink(filepath.Join(outside, "x.txt"), filepath.Join(home, "Documents", "escape.txt")))
	must(t, os.Symlink(filepath.Join(home, "Documents", "a.txt"), filepath.Join(home, "Documents", "alias.txt")))
	must(t, os.Symlink(filepath.Join(home, ".ssh"), filepath.Join(home, "Keys")))
	return home, outside
}

func TestExisting(t *testing.T) {
	home, _ := tree(t)
	r := Resolver{Home: home}
	p, err := r.Existing("~/Docs/a.txt")
	must(t, err)
	if p.Display != "~/Documents/a.txt" || p.Link || !p.Exists {
		t.Fatalf("through a folder link: %+v", p)
	}
	p, err = r.Existing(home + "/Documents/a.txt")
	must(t, err)
	if p.Display != "~/Documents/a.txt" {
		t.Fatalf("absolute under home: %+v", p)
	}
	p, err = r.Existing("~/Documents/alias.txt")
	must(t, err)
	if !p.Link || p.Display != "~/Documents/alias.txt" || filepath.Base(p.Target) != "a.txt" {
		t.Fatalf("link inside home keeps the link: %+v", p)
	}
	p, err = r.Existing("~")
	must(t, err)
	if !p.IsHome() {
		t.Fatalf("home: %+v", p)
	}
}

func TestExistingRefusals(t *testing.T) {
	home, outside := tree(t)
	r := Resolver{Home: home}
	for in, want := range map[string]mcp.Code{
		"~/Out/x.txt":             mcp.CodeDenied, // folder link leaves home
		"~/Documents/escape.txt":  mcp.CodeDenied, // file link leaves home
		"~/Keys/id_rsa":           mcp.CodeDenied, // link into ~/.ssh (key name refused first)
		"~/Keys":                  mcp.CodeDenied, // link into ~/.ssh
		"~/.ssh":                  mcp.CodeDenied,
		"~/.bashrc":               mcp.CodeDenied,
		"~/Documents/../.ssh":     mcp.CodeInvalid,
		"~/Documents//a.txt":      mcp.CodeInvalid,
		"Documents/a.txt":         mcp.CodeInvalid,
		outside + "/x.txt":        mcp.CodeInvalid,
		"/etc/passwd":             mcp.CodeInvalid,
		"~/Documents/a‮txt.exe":   mcp.CodeInvalid,
		"~/Documents/missing.txt": mcp.CodeNotFound,
		"~/Nope/a.txt":            mcp.CodeNotFound,
		"":                        mcp.CodeInvalid,
	} {
		if _, err := r.Existing(in); codeOf(err) != want {
			t.Errorf("%q: %v, want %s", in, err, want)
		}
	}
	if _, err := (Resolver{}).Existing("~/x"); codeOf(err) != mcp.CodeFailed {
		t.Errorf("no HOME: %v", err)
	}
}

func TestNew(t *testing.T) {
	home, _ := tree(t)
	r := Resolver{Home: home}
	p, err := r.New("~/Docs/Work/2026/report.txt")
	must(t, err)
	if p.Exists || p.Display != "~/Documents/Work/2026/report.txt" {
		t.Fatalf("missing tail under a folder link: %+v", p)
	}
	p, err = r.New("~/Documents/a.txt")
	must(t, err)
	if !p.Exists {
		t.Fatalf("existing destination must say so: %+v", p)
	}
	for in, want := range map[string]mcp.Code{
		"~/Out/new.txt":            mcp.CodeDenied,
		"~/Keys/new":               mcp.CodeDenied,
		"~/Documents/.hidden":      mcp.CodeDenied,
		"~/Documents/server.key":   mcp.CodeDenied,
		"~/Documents/a.txt/inside": mcp.CodeInvalid, // a file on the way
		"~/../x":                   mcp.CodeInvalid,
	} {
		if _, err := r.New(in); codeOf(err) != want {
			t.Errorf("%q: %v, want %s", in, err, want)
		}
	}
}

func TestValidName(t *testing.T) {
	for _, ok := range []string{"Report 2026.txt", "صور", "a-b_c.d"} {
		if err := ValidName(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", ".", "..", "a/b", ".env", "id_ed25519", "x\n", string(make([]byte, 256))} {
		if err := ValidName(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}
