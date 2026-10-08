package pkgtools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry/registrytest"
)

func iso(s string) string { return i18n.FSI + s + i18n.PDI }

// describeIn describes one call in a language, as jarvis.describe does.
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

func noBareLatin(t *testing.T, what string, d mcp.Description) {
	t.Helper()
	if d.Title == "" || i18n.LatinOutsideIsolates(d.Title) != "" || i18n.LatinOutsideIsolates(d.Detail) != "" {
		t.Errorf("%s: Arabic card has bare Latin text: %+v", what, d)
	}
}

func TestArabicInstallAndRemoveCards(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("Package: vlc\nVersion: 3.0.21-10\nSize: 45200000\n"), "apt-cache", "show", "--no-all-versions", "--", "vlc").
		On(execx.OK("vlc\t3.0.21-10\tinstalled\n"), "dpkg-query", "-W", dpkgFormat, "--", "vlc").
		On(execx.OK("\nSpotify - Online music streaming service\n\n  ID: com.spotify.Client\n  Version: 1.2.47\n  Download: 120.3 MB\n"), "flatpak", "remote-info", "--system", "flathub", "com.spotify.Client").
		On(execx.Exit(1, ""), "flatpak", "info", "com.spotify.Client")
	d := Deps{Run: run, Helper: &helperapi.Fake{}}

	en := describeIn(t, d, i18n.EN, "pkg.install", `{"items":[{"source":"apt","id":"vlc"}]}`)
	if en.Title != "Install vlc" || en.Detail != "vlc 3.0.21-10 from Debian, 45 MB download" {
		t.Fatalf("English changed: %+v", en)
	}
	ar := describeIn(t, d, i18n.AR, "pkg.install", `{"items":[{"source":"apt","id":"vlc"}]}`)
	wantTitle := i18n.RLM + "تثبيت " + iso("vlc")
	wantDetail := i18n.RLM + iso("vlc") + " " + iso("3.0.21-10") + " من " + iso(iso("Debian")) + "، حجم التنزيل " + iso("45 ميغابايت")
	if ar.Title != wantTitle || ar.Detail != wantDetail || ar.Source != mcp.SourceDebian {
		t.Fatalf("Arabic install card\n got %+q\nwant %q / %q", ar, wantTitle, wantDetail)
	}
	two := describeIn(t, d, i18n.AR, "pkg.install", `{"items":[{"source":"apt","id":"vlc"},{"source":"flatpak","id":"com.spotify.Client"}]}`)
	if two.Title != i18n.RLM+"تثبيت 2 من التطبيقات: "+iso("vlc, Spotify") {
		t.Fatalf("Arabic many-title %q", two.Title)
	}
	rm := describeIn(t, d, i18n.AR, "pkg.remove", `{"items":[{"source":"apt","id":"vlc"}]}`)
	if rm.Title != i18n.RLM+"إزالة "+iso("vlc") || !strings.Contains(rm.Detail, "يحرّر نحو") {
		t.Fatalf("Arabic remove card %+v", rm)
	}
	for _, c := range []mcp.Description{ar, two, rm} {
		noBareLatin(t, "pkg card", c)
	}
}

func TestArabicUpdateCard(t *testing.T) {
	policy := "linux-libc-dev:\n  Installed: 6.12.63-1\n  Candidate: 6.12.111-1\n  Version table:\n     6.12.111-1 500\n        500 http://deb.debian.org/debian-security trixie-security/main amd64 Packages\n *** 6.12.63-1 100\n        100 /var/lib/dpkg/status\n"
	d := updatesDeps((&execx.Fake{}).On(execx.OK(policy), "apt-cache", "policy", "--", "linux-libc-dev"), &helperapi.Fake{})
	got := describeIn(t, d, i18n.AR, "updates.apply", `{"items":[{"source":"apt","id":"linux-libc-dev"}]}`)
	wantTitle := i18n.RLM + "ترقية " + iso("linux-libc-dev") + " من " + iso("6.12.63-1") + " إلى " + iso("6.12.111-1") +
		" (" + iso(iso("Debian")+"، تحديث أمني") + ")"
	wantDetail := i18n.RLM + iso("linux-libc-dev") + " من " + iso("6.12.63-1") + " إلى " + iso("6.12.111-1") +
		" عبر " + iso(iso("Debian")) + iso(" (تحديث أمني)") + ". لن يُزال أي شيء."
	if got.Title != wantTitle || got.Detail != wantDetail {
		t.Fatalf("Arabic update card\n got %q\n     %q\nwant %q\n     %q", got.Title, got.Detail, wantTitle, wantDetail)
	}
	unknown := describeIn(t, updatesDeps(&execx.Fake{}, &helperapi.Fake{}), i18n.AR, "updates.apply", `{"items":[{"source":"apt","id":"curl"}]}`)
	if unknown.Title != i18n.RLM+"ترقية "+iso("curl")+" ("+iso(iso("Debian"))+")" ||
		unknown.Detail != i18n.RLM+iso("curl")+": أحدث إصدار عبر "+iso(iso("Debian"))+". لن يُزال أي شيء." {
		t.Fatalf("Arabic unknown-version card %+q", unknown)
	}
	noBareLatin(t, "update card", got)
}

func TestArabicRegistryCards(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, _ := registryDeps(t, fr, s)
	got := describeIn(t, d, i18n.AR, "registry.install", `{"id":"weather","version":"1.2.0"}`)
	want := mcp.Description{
		Title: i18n.RLM + "إضافة خادم الأدوات " + iso("Weather") + " " + iso("1.2.0"),
		Detail: "مجتمعي: لم يراجعه مشروع رفيق، وسيستأذنك قبل كل إجراء يقوم به" +
			" · " + i18n.RLM + "الأدوات: " + iso("weather.today") +
			" · " + "يمكنه استخدام الإنترنت" +
			" · " + i18n.RLM + "يمكنه قراءة مجلدك الشخصي، ويمكنه تغيير: " + iso("~/Documents/Weather"),
		Source: mcp.SourceNetwork,
	}
	if got != want {
		t.Fatalf("Arabic registry card\n got %+q\nwant %+q", got, want)
	}
	if _, err := call(t, d, "registry.install", `{"id":"notes","version":"2.0.0"}`); err != nil {
		t.Fatal(err)
	}
	rm := describeIn(t, d, i18n.AR, "registry.remove", `{"id":"notes"}`)
	if rm.Title != i18n.RLM+"إزالة خادم الأدوات "+iso("notes") || rm.Detail != i18n.RLM+"سيُحذف الإصدار "+iso("2.0.0")+" وملفاته، وتتوقف أدواته عن العمل." {
		t.Fatalf("Arabic registry remove %+q", rm)
	}
}

func TestHumanBytesInArabic(t *testing.T) {
	for n, want := range map[int64]string{0: "0 بايت", 45_200_000: "45 ميغابايت", 3_200_000_000: "3.2 غيغابايت", 1500: "1.5 كيلوبايت"} {
		if got := humanBytes(i18n.AR, n); got != want {
			t.Errorf("humanBytes(ar, %d) = %q, want %q", n, got, want)
		}
	}
}
