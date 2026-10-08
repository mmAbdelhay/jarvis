package apptools

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

func iso(s string) string { return i18n.FSI + s + i18n.PDI }

func describeIn(t *testing.T, d Deps, l i18n.Lang, name, args string) mcp.Description {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			desc, err := tool.Describe(i18n.WithLang(context.Background(), l), json.RawMessage(args))
			if err != nil {
				t.Fatalf("%s %s: %v", name, args, err)
			}
			return desc
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}
}

func TestAppsCardTableIsComplete(t *testing.T) {
	for _, p := range i18n.Check(cardText.Get(i18n.EN), cardText.Get(i18n.AR)) {
		t.Errorf("cardText.%s", p)
	}
}

func TestArabicAppsCards(t *testing.T) {
	win := &fakeWindows{list: []wl.Window{
		{ID: "w1", AppID: "Code", Title: "site — Visual Studio Code"},
		{ID: "w2", AppID: "firefox-esr", Title: "Inbox"},
		{ID: "w3", AppID: "firefox-esr", Title: "News"},
	}}
	run := (&execx.Fake{}).On(execx.OK("chromium.desktop\n"), "xdg-mime", "query", "default", "x-scheme-handler/https")
	d, _ := deps(t, run, win)

	one := describeIn(t, d, i18n.AR, "apps.close", `{"windowId":"w1"}`)
	if one.Title != i18n.RLM+"إغلاق "+iso("site — Visual Studio Code") ||
		one.Detail != i18n.RLM+iso("Code")+" · قد يضيع العمل غير المحفوظ إن لم يسألك التطبيق أولًا." {
		t.Fatalf("close one %+q", one)
	}
	all := describeIn(t, d, i18n.AR, "apps.close", `{"appId":"firefox-esr"}`)
	if all.Title != i18n.RLM+"إغلاق كل نوافذ "+iso("firefox-esr")+" (2)" {
		t.Fatalf("close all %q", all.Title)
	}
	def := describeIn(t, d, i18n.AR, "apps.set_default", `{"mimeType":"x-scheme-handler/https","appId":"firefox-esr"}`)
	if def.Title != i18n.RLM+"جعل "+iso("فايرفوكس")+" التطبيق الافتراضي لـ"+iso("x-scheme-handler/https") ||
		def.Detail != i18n.RLM+iso("chromium")+" ← "+iso("firefox-esr") {
		t.Fatalf("set default %+q", def)
	}
	if en := describeIn(t, d, i18n.EN, "apps.set_default", `{"mimeType":"x-scheme-handler/https","appId":"firefox-esr"}`); en.Title != "Make Firefox ESR the default for x-scheme-handler/https" || en.Detail != "chromium → firefox-esr" {
		t.Fatalf("English must stay as before: %+q", en)
	}
	url := describeIn(t, d, i18n.AR, "apps.open_url", `{"target":"https://example.org/a"}`)
	if url.Title != i18n.RLM+"فتح "+iso("https://example.org/a") || url.Detail != i18n.RLM+"في تطبيق "+iso("الويب")+" الافتراضي لديك. الصفحة على الإنترنت." {
		t.Fatalf("open url %+q", url)
	}
	for _, c := range []mcp.Description{one, all, def, url} {
		if s := i18n.LatinOutsideIsolates(c.Title + " " + c.Detail); s != "" {
			t.Errorf("bare Latin %q in %+q", s, c)
		}
	}
}
