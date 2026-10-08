package filestools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func iso(s string) string { return i18n.FSI + s + i18n.PDI }

func describeWIn(t *testing.T, w WriteDeps, l i18n.Lang, name, args string) mcp.Description {
	t.Helper()
	for _, tool := range WriteTools(w) {
		if tool.Name == name {
			d, err := tool.Describe(i18n.WithLang(context.Background(), l), json.RawMessage(args))
			if err != nil {
				t.Fatalf("%s %s: %v", name, args, err)
			}
			return d
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}
}

func TestWriteCardTableIsComplete(t *testing.T) {
	for _, p := range i18n.Check(writeCardText.Get(i18n.EN), writeCardText.Get(i18n.AR)) {
		t.Errorf("writeCardText.%s", p)
	}
}

func TestArabicFileCards(t *testing.T) {
	w, _ := writeDeps(t)
	trash := describeWIn(t, w, i18n.AR, "files.trash", `{"items":[{"from":"~/Documents/a.txt"}]}`)
	if trash.Title != i18n.RLM+"نقل "+iso("a.txt")+" إلى سلة المهملات" ||
		trash.Detail != i18n.RLM+iso("~/Documents/a.txt")+" · يمكنك استعادته من سلة المهملات، أو قل «تراجع»." {
		t.Fatalf("trash card %+q", trash)
	}
	mkdir := describeWIn(t, w, i18n.AR, "files.mkdir", `{"items":[{"from":"~/Projects/new"}]}`)
	if mkdir.Title != i18n.RLM+"إنشاء المجلد "+iso("~/Projects/new") || mkdir.Detail != iso("~/Projects/new") {
		t.Fatalf("mkdir card %+q", mkdir)
	}
	move := describeWIn(t, w, i18n.AR, "files.move", `{"items":[{"from":"~/Desktop/shot.png","to":"~/Pictures/"}]}`)
	enMove := describeWIn(t, w, i18n.EN, "files.move", `{"items":[{"from":"~/Desktop/shot.png","to":"~/Pictures/"}]}`)
	if move.Title == enMove.Title || !strings.Contains(move.Detail, " ← ") || !strings.Contains(move.Detail, iso("~/Desktop/shot.png")) {
		t.Fatalf("move card %+q (English %+q)", move, enMove)
	}
	refused := describeWIn(t, w, i18n.AR, "files.rename", `{"items":[{"from":"~/Documents/missing.txt","to":"b.txt"}]}`)
	if !strings.Contains(refused.Detail, "سيُرفض هذا: ") {
		t.Fatalf("refusal detail %q", refused.Detail)
	}
	for _, c := range []mcp.Description{trash, mkdir, move, refused} {
		if s := i18n.LatinOutsideIsolates(c.Title + " " + c.Detail); s != "" {
			t.Errorf("bare Latin %q in %+q", s, c)
		}
	}
}
