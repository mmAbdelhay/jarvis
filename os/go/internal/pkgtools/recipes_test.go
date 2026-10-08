package pkgtools

import (
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/recipes"
)

func stepJSON(tool, input string) string {
	return `{"tool":"` + tool + `","input":` + input + `,"title":{"en":"Step","ar":"خطوة"}}`
}

func recipeJSON(id string, steps ...string) string {
	return `{"id":"` + id + `","title":{"en":"Title","ar":"عنوان"},"description":{"en":"Desc.","ar":"وصف."},"steps":[` +
		strings.Join(steps, ",") + `],"requires":{"os":"rafiq","minRamGB":4}}`
}

const goodInstall = `{"items":[{"source":"apt","id":"python3"}]}`

func recipeFS(memKB int, files map[string]string) fstest.MapFS {
	m := fstest.MapFS{
		"etc/os-release":           {Data: []byte("NAME=\"Rafiq\"\nID=rafiq\n")},
		"proc/meminfo":             {Data: []byte(fmt.Sprintf("MemTotal:        %d kB\n", memKB))},
		"usr/share/jarvis/recipes": {Mode: fs.ModeDir | 0o755},
	}
	for name, body := range files {
		m["usr/share/jarvis/recipes/"+name] = &fstest.MapFile{Data: []byte(body), Mode: 0o644}
	}
	return m
}

func recipeDeps(fsys fstest.MapFS) Deps {
	return Deps{Run: &execx.Fake{}, Helper: &helperapi.Fake{}, FS: fsys,
		Recipes: &recipes.Store{FS: fsys, Dir: recipes.DefaultDir, Trusted: func(fs.FileInfo) error { return nil }}}
}

func TestRecipesListTool(t *testing.T) {
	files := map[string]string{
		"python-dev.json": recipeJSON("python-dev", stepJSON("pkg.install", goodInstall), stepJSON("note", `{}`)),
		"sneaky.json":     recipeJSON("sneaky", stepJSON("pkg.remove", goodInstall)),
		"bad-input.json":  recipeJSON("bad-input", stepJSON("pkg.install", `{"items":[{"source":"apt","id":"-oAPT::Foo=1"}]}`)),
		"broken.json":     "{",
	}
	d := recipeDeps(recipeFS(7864320, files))
	v, err := call(t, d, "recipes.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	rs := m["recipes"].([]any)
	if len(rs) != 1 {
		t.Fatalf("recipes %v", rs)
	}
	r := rs[0].(map[string]any)
	if r["id"] != "python-dev" || r["available"] != true || len(r["digest"].(string)) != 16 || len(r["steps"].([]any)) != 2 {
		t.Fatalf("recipe %v", r)
	}
	if _, has := r["reason"]; has {
		t.Fatalf("available recipe has no reason: %v", r)
	}
	s := r["steps"].([]any)[1].(map[string]any)
	if s["index"] != 1.0 || s["tool"] != "note" || s["title"].(map[string]any)["ar"] != "خطوة" {
		t.Fatalf("step %v", s)
	}
	skipped := fmt.Sprint(m["skipped"])
	for _, want := range []string{"pkg.remove", "bad-input", "broken.json"} {
		if !strings.Contains(skipped, want) {
			t.Errorf("skipped lacks %s: %s", want, skipped)
		}
	}
}

func TestRecipesListAvailability(t *testing.T) {
	small := recipeDeps(recipeFS(2*1024*1024, map[string]string{"a.json": recipeJSON("a", stepJSON("pkg.install", goodInstall))}))
	v, _ := call(t, small, "recipes.list", `{}`)
	r := asJSON(t, v)["recipes"].([]any)[0].(map[string]any)
	if r["available"] != false || !strings.Contains(r["reason"].(string), "4 GB") {
		t.Fatalf("2 GiB computer: %v", r)
	}
	// 90% rule: 3.7 GiB of a 4 GB recipe fits.
	ok := recipeDeps(recipeFS(3700*1024, map[string]string{"a.json": recipeJSON("a", stepJSON("pkg.install", goodInstall))}))
	v, _ = call(t, ok, "recipes.list", `{}`)
	if asJSON(t, v)["recipes"].([]any)[0].(map[string]any)["available"] != true {
		t.Fatal("90% of the stated memory must fit")
	}
	// contracts §6.15: shipped but unavailable.
	off := strings.Replace(recipeJSON("ws", stepJSON("pkg.install", goodInstall)), `"requires"`, `"available":false,"requires"`, 1)
	d := recipeDeps(recipeFS(7864320, map[string]string{"ws.json": off}))
	v, _ = call(t, d, "recipes.list", `{}`)
	r = asJSON(t, v)["recipes"].([]any)[0].(map[string]any)
	if r["available"] != false || r["reason"] == "" {
		t.Fatalf("unavailable recipe: %v", r)
	}
	v, err := call(t, Deps{}, "recipes.list", `{}`)
	if err != nil || len(asJSON(t, v)["recipes"].([]any)) != 0 {
		t.Fatalf("no store: %v %v", v, err)
	}
}

func TestNoRecipesRunTool(t *testing.T) {
	for _, tl := range Tools(recipeDeps(recipeFS(7864320, nil))) {
		if tl.Name == "recipes.run" {
			t.Fatal("jarvisd runs recipes itself (contracts §6.1); jarvis-pkg has no recipes.run")
		}
	}
}

func TestCheckRecipe(t *testing.T) {
	parse := func(steps ...string) recipes.Recipe {
		r, err := recipes.Parse([]byte(recipeJSON("x", steps...)))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	ok := [][]string{
		{stepJSON("pkg.install", goodInstall)},
		{stepJSON("svc.restart", `{"unit":"docker"}`)},
		{stepJSON("svc.restart", `{"unit":"pipewire","scope":"user"}`)},
		{stepJSON("apps.set_default", `{"mimeType":"application/pdf","appId":"evince"}`)},
		{stepJSON("note", `{}`)},
	}
	for _, s := range ok {
		if err := CheckRecipe(parse(s...)); err != nil {
			t.Errorf("%v: %v", s, err)
		}
	}
	bad := [][]string{
		{stepJSON("pkg.remove", goodInstall)},
		{stepJSON("net.wifi_connect", `{"ssid":"x"}`)},
		{stepJSON("pkg.install", `{"items":[{"source":"apt","id":"-oX"}]}`)},
		{stepJSON("pkg.install", `{}`)},
		{stepJSON("svc.restart", `{"unit":"sshd"}`)},
		{stepJSON("svc.restart", `{"unit":"docker","extra":1}`)},
		{stepJSON("apps.set_default", `{"mimeType":"application/pdf"}`)},
		{stepJSON("note", `{"cmd":"x"}`)},
		{stepJSON("pkg.install", goodInstall), stepJSON("shell.run", `{}`)},
	}
	for _, s := range bad {
		if err := CheckRecipe(parse(s...)); err == nil {
			t.Errorf("%v must be refused", s)
		}
	}
}
