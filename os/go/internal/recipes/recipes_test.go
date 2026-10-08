package recipes

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
)

const good = `{
  "id": "python-dev",
  "title": {"en": "Python development", "ar": "تطوير بايثون"},
  "description": {"en": "Python 3 with virtual environments and pipx.", "ar": "بايثون 3 مع البيئات الافتراضية وأداة pipx."},
  "steps": [
    {"tool": "pkg.install", "input": {"items": [{"source": "apt", "id": "python3-venv"}]}, "title": {"en": "Install Python 3", "ar": "تثبيت بايثون 3"}}
  ],
  "requires": {"os": "rafiq", "minRamGB": 4}
}`

func TestParseGoodRecipe(t *testing.T) {
	r, err := Parse([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "python-dev" || len(r.Steps) != 1 || r.Steps[0].Tool != "pkg.install" || r.Requires.MinRAMGB != 4 || len(r.Digest) != 16 {
		t.Fatalf("%+v", r)
	}
	if r.Title.In(i18n.AR) != "تطوير بايثون" || r.Title.In(i18n.EN) != "Python development" {
		t.Fatal("Text.In picks the wrong language")
	}
	var in map[string]any
	if json.Unmarshal(r.Steps[0].Input, &in) != nil || in["items"] == nil {
		t.Fatal("step input must be kept as raw JSON")
	}
	r2, _ := Parse([]byte(strings.Replace(good, "pipx.", "pipx!", 1)))
	if r2.Digest == r.Digest {
		t.Fatal("the digest must change when the bytes change")
	}
}

func recipeJSON(t *testing.T, edit func(m map[string]any)) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(good), &m); err != nil {
		t.Fatal(err)
	}
	edit(m)
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func step(m map[string]any) map[string]any { return m["steps"].([]any)[0].(map[string]any) }

func TestParseRefusals(t *testing.T) {
	cases := map[string]func(m map[string]any){
		"unknown field":     func(m map[string]any) { m["run"] = "rm -rf ~" },
		"bad id":            func(m map[string]any) { m["id"] = "Python Dev" },
		"path in id":        func(m map[string]any) { m["id"] = "../etc" },
		"missing ar title":  func(m map[string]any) { m["title"] = map[string]any{"en": "Python"} },
		"control character": func(m map[string]any) { m["title"] = map[string]any{"en": "Py\u0007thon", "ar": "بايثون"} },
		"long title": func(m map[string]any) {
			m["title"] = map[string]any{"en": strings.Repeat("a", 121), "ar": "بايثون"}
		},
		"no steps": func(m map[string]any) { m["steps"] = []any{} },
		"too many steps": func(m map[string]any) {
			s := m["steps"].([]any)[0]
			many := []any{}
			for i := 0; i < 21; i++ {
				many = append(many, s)
			}
			m["steps"] = many
		},
		"step without tool":   func(m map[string]any) { step(m)["tool"] = "" },
		"input not an object": func(m map[string]any) { step(m)["input"] = []any{1} },
		"null input":          func(m map[string]any) { step(m)["input"] = nil },
		"unknown step field":  func(m map[string]any) { step(m)["sudo"] = true },
		"missing step title":  func(m map[string]any) { delete(step(m), "title") },
		"bad os":              func(m map[string]any) { m["requires"] = map[string]any{"os": ""} },
		"negative ram":        func(m map[string]any) { m["requires"] = map[string]any{"os": "rafiq", "minRamGB": -1} },
		"absurd ram":          func(m map[string]any) { m["requires"] = map[string]any{"os": "rafiq", "minRamGB": 5000} },
		"too big": func(m map[string]any) {
			m["description"] = map[string]any{"en": strings.Repeat("a", 70000), "ar": "و"}
		},
	}
	for name, edit := range cases {
		if _, err := Parse(recipeJSON(t, edit)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := Parse([]byte(good + ` {}`)); err == nil {
		t.Error("trailing data accepted")
	}
}

func file(s string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(s), Mode: 0o644} }

func mapFS(files map[string]*fstest.MapFile) fstest.MapFS {
	m := fstest.MapFS{DefaultDir: {Mode: fs.ModeDir | 0o755}}
	for name, f := range files {
		m[DefaultDir+"/"+name] = f
	}
	return m
}

func trusting(fsys fs.FS) *Store {
	return &Store{FS: fsys, Dir: DefaultDir, Trusted: func(fs.FileInfo) error { return nil }}
}

func TestStoreListAndGet(t *testing.T) {
	s := trusting(mapFS(map[string]*fstest.MapFile{
		"python-dev.json": file(good),
		"node-dev.json":   file(strings.Replace(good, `"python-dev"`, `"node-dev"`, 1)),
		"misnamed.json":   file(strings.Replace(good, `"python-dev"`, `"go-dev"`, 1)),
		"broken.json":     file("{"),
		"README.md":       file("not a recipe"),
		"link.json":       {Data: []byte(good), Mode: fs.ModeSymlink | 0o777},
	}))
	list, probs, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != "node-dev" || list[1].ID != "python-dev" {
		t.Fatalf("list %+v", list)
	}
	got := map[string]string{}
	for _, p := range probs {
		got[p.File] = p.Reason
	}
	if len(got) != 3 || !strings.Contains(got["misnamed.json"], "go-dev.json") || got["broken.json"] == "" || !strings.Contains(got["link.json"], "regular file") {
		t.Fatalf("problems %v", got)
	}
	if r, err := s.Get("python-dev"); err != nil || r.ID != "python-dev" {
		t.Fatalf("Get: %+v, %v", r, err)
	}
	for _, id := range []string{"go-dev", "../../etc/passwd", "README", ""} {
		if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) = %v, want ErrNotFound", id, err)
		}
	}
	if _, err := s.Get("misnamed"); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("Get(misnamed) = %v, want a format error", err)
	}
	if _, err := s.Get("link"); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Errorf("Get(link) = %v", err)
	}
}

func TestStoreWithoutRecipesIsEmpty(t *testing.T) {
	list, probs, err := (&Store{FS: fstest.MapFS{}, Dir: DefaultDir}).List()
	if err != nil || len(list) != 0 || len(probs) != 0 {
		t.Fatalf("%v %v %v", list, probs, err)
	}
}

// By default only root-owned files count: a MapFS file has no owner.
func TestStoreRefusesUntrustedFilesByDefault(t *testing.T) {
	s := &Store{FS: mapFS(map[string]*fstest.MapFile{"python-dev.json": file(good)}), Dir: DefaultDir}
	if _, _, err := s.List(); err == nil || !strings.Contains(err.Error(), "not owned by root") {
		t.Fatalf("List: %v", err)
	}
	if _, err := s.Get("python-dev"); err == nil || !strings.Contains(err.Error(), "not owned by root") {
		t.Fatalf("Get: %v", err)
	}
}

func TestRootOwned(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.json")
	if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Lstat(p)
	err := RootOwned(fi)
	if os.Getuid() == 0 {
		if err != nil {
			t.Fatalf("root-owned file refused: %v", err)
		}
	} else if err == nil || !strings.Contains(err.Error(), "not owned by root") {
		t.Fatalf("user-owned file: %v", err)
	}
	if err := os.Chmod(p, 0o664); err != nil {
		t.Fatal(err)
	}
	fi, _ = os.Lstat(p)
	if err := RootOwned(fi); err == nil || !strings.Contains(err.Error(), "writable") {
		t.Fatalf("group-writable: %v", err)
	}
	l := filepath.Join(dir, "l.json")
	if err := os.Symlink(p, l); err != nil {
		t.Fatal(err)
	}
	fi, _ = os.Lstat(l)
	if err := RootOwned(fi); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("symlink: %v", err)
	}
}

func TestReadHostAndFits(t *testing.T) {
	h := ReadHost(fstest.MapFS{
		"etc/os-release": {Data: []byte("NAME=\"Rafiq\"\nID=\"rafiq\"\nVERSION_ID=0.2\n")},
		"proc/meminfo":   {Data: []byte("MemTotal:        7864320 kB\nMemFree: 1 kB\n")},
	})
	if h.OSID != "rafiq" || h.MemTotalBytes != 7864320*1024 {
		t.Fatalf("%+v", h)
	}
	r, _ := Parse([]byte(good))
	if ok, why := r.Fits(h); !ok {
		t.Fatal(why)
	}
	r.Requires.MinRAMGB = 8
	if ok, why := r.Fits(h); !ok {
		t.Fatalf("an 8 GB computer (7.5 GiB usable) must fit an 8 GB recipe: %s", why)
	}
	r.Requires.MinRAMGB = 16
	if ok, why := r.Fits(h); ok || !strings.Contains(why, "16 GB") {
		t.Fatalf("16 GB: %v %q", ok, why)
	}
	if ok, why := r.Fits(Host{OSID: "debian", MemTotalBytes: h.MemTotalBytes}); ok || !strings.Contains(why, "debian") {
		t.Fatalf("debian: %v %q", ok, why)
	}
	if h := ReadHost(fstest.MapFS{"usr/lib/os-release": {Data: []byte("ID=rafiq\n")}}); h.OSID != "rafiq" {
		t.Fatalf("usr/lib fallback: %+v", h)
	}
	if h := ReadHost(fstest.MapFS{}); h.OSID != "" || h.MemTotalBytes != 0 {
		t.Fatalf("empty: %+v", h)
	}
}

func TestAvailableFlag(t *testing.T) {
	r, err := Parse([]byte(good))
	if err != nil || !r.IsAvailable() {
		t.Fatalf("default must be available: %v", err)
	}
	r, err = Parse(recipeJSON(t, func(m map[string]any) { m["available"] = false }))
	if err != nil || r.IsAvailable() {
		t.Fatalf("available:false: %v", err)
	}
}
