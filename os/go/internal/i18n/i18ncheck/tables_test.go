package i18ncheck_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mmAbdelhay/jarvis/os/go/internal/admintools"
	_ "github.com/mmAbdelhay/jarvis/os/go/internal/apptools"
	_ "github.com/mmAbdelhay/jarvis/os/go/internal/diagtools"
	_ "github.com/mmAbdelhay/jarvis/os/go/internal/filestools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	_ "github.com/mmAbdelhay/jarvis/os/go/internal/install"
	_ "github.com/mmAbdelhay/jarvis/os/go/internal/pkgtools"
	_ "github.com/mmAbdelhay/jarvis/os/go/internal/settingstools"
)

// wantTables is every card table of every Go tool server. A new server or
// table adds its name here and its package to the imports above.
// Recipes cards belong to jarvisd under M4 contracts §6; Go only lists recipes.
var wantTables = []string{
	"jarvis-apps/card",
	"jarvis-diag/card",
	"jarvis-files/card",
	"jarvis-installer/text",
	"jarvis-pkg/card",
	"jarvis-pkg/registry",
	"jarvis-settings/admin",
	"jarvis-settings/settings",
}

func TestEveryTableIsComplete(t *testing.T) {
	var names []string
	for _, tb := range i18n.All() {
		names = append(names, tb.Name)
		for _, p := range i18n.Check(tb.EN, tb.AR) {
			t.Errorf("%s: %s", tb.Name, p)
		}
	}
	if strings.Join(names, ",") != strings.Join(wantTables, ",") {
		t.Fatalf("registered tables\n got %v\nwant %v", names, wantTables)
	}
}

// A package that builds confirm cards (has a Describe) must register a
// table, or its cards would stay English forever without failing CI.
func TestEveryServerWithCardsHasATable(t *testing.T) {
	root := filepath.Join("..", "..")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "mcp" || e.Name() == "i18n" || e.Name() == "contract" {
			continue
		}
		files, _ := filepath.Glob(filepath.Join(root, e.Name(), "*.go"))
		var describes, table bool
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			b, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			describes = describes || bytes.Contains(b, []byte("Describe:"))
			table = table || bytes.Contains(b, []byte("i18n.NewTable("))
		}
		if describes {
			checked++
			if !table {
				t.Errorf("internal/%s builds confirm cards but registers no i18n table", e.Name())
			}
		}
	}
	if checked < 6 {
		t.Fatalf("found only %d packages with cards; the scan is not looking at internal/", checked)
	}
}
