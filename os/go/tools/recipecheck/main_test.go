package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const good = `{"id":"go-dev","title":{"en":"Go development","ar":"تطوير برامج بلغة غو"},"description":{"en":"The Go toolchain.","ar":"أدوات البرمجة بلغة غو."},"steps":[{"tool":"pkg.install","input":{"items":[{"source":"apt","id":"golang"}]},"title":{"en":"Install Go","ar":"تثبيت أدوات لغة غو"}}],"requires":{"os":"rafiq"}}`

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGoodRecipesPass(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "go-dev.json", good)
	var out, errb bytes.Buffer
	if code := run([]string{dir}, &out, &errb); code != 0 || !strings.Contains(out.String(), "ok go-dev (1 steps)") {
		t.Fatalf("code %d out %q err %q", code, out.String(), errb.String())
	}
}

func TestBadRecipesFail(t *testing.T) {
	cases := map[string]string{
		"go-dev.json": strings.Replace(good, `"pkg.install"`, `"net.radio_on"`, 1),
		"other.json":  good,
		"bad-ar.json": strings.Replace(strings.Replace(good, `"go-dev"`, `"bad-ar"`, 1), `"ar":"تطوير برامج بلغة غو"`, `"ar":""`, 1),
		"badpkg.json": strings.Replace(strings.Replace(good, `"go-dev"`, `"badpkg"`, 1), `"golang"`, `"-oFoo=1"`, 1),
	}
	for name, body := range cases {
		dir := t.TempDir()
		write(t, dir, name, body)
		var out, errb bytes.Buffer
		if code := run([]string{dir}, &out, &errb); code != 1 || errb.Len() == 0 {
			t.Errorf("%s: code %d err %q", name, code, errb.String())
		}
	}
	var out, errb bytes.Buffer
	if code := run([]string{t.TempDir()}, &out, &errb); code != 1 || !strings.Contains(errb.String(), "no recipes") {
		t.Errorf("empty dir: %d %q", code, errb.String())
	}
	if code := run(nil, &out, &errb); code != 2 {
		t.Errorf("usage: %d", code)
	}
}

func TestResolvedStepAllowlist(t *testing.T) {
	for _, step := range []string{
		`{"tool":"svc.restart","input":{"unit":"example.service","scope":"user"},"title":{"en":"Restart service","ar":"إعادة تشغيل الخدمة"}}`,
		`{"tool":"apps.set_default","input":{"mimeType":"text/plain","appId":"editor.desktop"},"title":{"en":"Set default app","ar":"تعيين التطبيق الافتراضي"}}`,
		`{"tool":"note","input":{},"title":{"en":"Follow the instructions","ar":"اتبع التعليمات"}}`,
	} {
		dir := t.TempDir()
		start := strings.Index(good, `"steps":[`) + len(`"steps":[`)
		end := strings.Index(good[start:], `],"requires"`) + start
		write(t, dir, "go-dev.json", good[:start]+step+good[end:])
		var out, errb bytes.Buffer
		if code := run([]string{dir}, &out, &errb); code != 0 || out.String() != "ok go-dev (1 steps)\n" || errb.Len() != 0 {
			t.Fatalf("step %s: code %d out %q err %q", step, code, out.String(), errb.String())
		}
	}
}
