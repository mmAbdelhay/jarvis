package i18n

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func iso(s string) string { return FSI + s + PDI }

func TestParseAndContext(t *testing.T) {
	for in, want := range map[string]Lang{"": EN, "en": EN, "ar": AR} {
		if got, ok := Parse(in); !ok || got != want {
			t.Errorf("Parse(%q) = %q, %v", in, got, ok)
		}
	}
	for _, bad := range []string{"fr", "AR", "ar-EG", " ar", "en_US"} {
		if _, ok := Parse(bad); ok {
			t.Errorf("Parse(%q) accepted", bad)
		}
	}
	if FromContext(context.Background()) != EN {
		t.Fatal("no language in the context must read as English")
	}
	if FromContext(WithLang(context.Background(), AR)) != AR {
		t.Fatal("Arabic lost on the way through the context")
	}
	if FromContext(WithLang(context.Background(), Lang("fr"))) != EN {
		t.Fatal("an unknown language must read as English")
	}
}

type sample struct {
	Title string
	Name  string `i18n:"keep"`
}

func TestTableGetInAndRegistry(t *testing.T) {
	name := fmt.Sprintf("test/get-%d", time.Now().UnixNano())
	tb := NewTable(name, sample{Title: "Install %s", Name: "Debian"}, sample{Title: "تثبيت %s", Name: iso("Debian")})
	if tb.Get(EN).Title != "Install %s" || tb.Get(AR).Title != "تثبيت %s" || tb.Get(Lang("x")).Title != "Install %s" {
		t.Fatal("Get picks the wrong language")
	}
	if tb.In(WithLang(context.Background(), AR)).Title != "تثبيت %s" || tb.In(context.Background()).Title != "Install %s" {
		t.Fatal("In does not follow the context")
	}
	found := false
	for _, r := range All() {
		if r.Name == name {
			found = reflect.DeepEqual(r.EN, sample{Title: "Install %s", Name: "Debian"})
		}
	}
	if !found {
		t.Fatal("NewTable did not register the pair")
	}
	defer func() {
		if recover() == nil {
			t.Fatal("registering the same name twice must panic")
		}
	}()
	NewTable(name, sample{}, sample{})
}

func TestSprintfIsolatesValuesInArabicOnly(t *testing.T) {
	cases := []struct {
		l      Lang
		format string
		args   []any
		want   string
	}{
		{EN, "Install %s", []any{"vlc"}, "Install vlc"},
		{EN, `Connect to Wi-Fi %q`, []any{"Cafe"}, `Connect to Wi-Fi "Cafe"`},
		{AR, "تثبيت %s", []any{"vlc"}, RLM + "تثبيت " + iso("vlc")},
		{AR, "الاتصال بشبكة الواي فاي %q", []any{"Cafe"}, RLM + "الاتصال بشبكة الواي فاي " + iso(`"Cafe"`)},
		{AR, "ضبط سطوع الشاشة على %d%%", []any{40}, RLM + "ضبط سطوع الشاشة على 40%"},
		{AR, "إغلاق كل نوافذ %[2]s (%[1]d)", []any{3, "firefox-esr"}, RLM + "إغلاق كل نوافذ " + iso("firefox-esr") + " (3)"},
		{AR, "سيُرفض هذا: %s", []any{errors.New("no such file")}, RLM + "سيُرفض هذا: " + iso("no such file")},
		{AR, "ضبط تكبير الشاشة %s على %g", []any{"eDP-1", 1.5}, RLM + "ضبط تكبير الشاشة " + iso("eDP-1") + " على 1.5"},
		{AR, "%s: أحدث إصدار عبر %s%s.", []any{"curl", "Debian", ""}, RLM + iso("curl") + ": أحدث إصدار عبر " + iso("Debian") + "."},
	}
	for _, c := range cases {
		if got := Sprintf(c.l, c.format, c.args...); got != c.want {
			t.Errorf("Sprintf(%s, %q)\n got %q\nwant %q", c.l, c.format, got, c.want)
		}
	}
}

func TestIso(t *testing.T) {
	if Iso(EN, "~/a") != "~/a" || Iso(AR, "~/a") != iso("~/a") || Iso(AR, "") != "" {
		t.Fatal("Iso wraps only non-empty Arabic-mode values")
	}
}

func TestLatinOutsideIsolates(t *testing.T) {
	cases := map[string]string{
		RLM + "تثبيت " + iso("vlc"):          "",
		"تثبيت vlc":                          "vlc",
		iso("a "+iso("b")+" c") + " · مرحبا": "",
		"40% · ٤٠ · 1.5":                     "",
		"تثبيت " + FSI + "vlc":               "",
		"Wi-Fi مطفأ":                         "Wi",
		"مرحبا" + PDI + " Debian":            "Debian",
	}
	for in, want := range cases {
		if got := LatinOutsideIsolates(in); got != want {
			t.Errorf("LatinOutsideIsolates(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestVerbs(t *testing.T) {
	good := map[string]map[int]string{
		"Install %d apps: %s":          {1: "d", 2: "s"},
		"إغلاق كل نوافذ %[2]s (%[1]d)": {1: "d", 2: "s"},
		"until %02d:00":                {1: "02d"},
		"%d%%":                         {1: "d"},
		"%5[2]d %[1]s":                 {1: "s", 2: "5d"},
		"%[1]s and %[1]s":              {1: "s"},
		"no verbs at all":              {},
		"%.1f %s":                      {1: ".1f", 2: "s"},
	}
	for f, want := range good {
		got, err := Verbs(f)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("Verbs(%q) = %v, %v; want %v", f, got, err, want)
		}
	}
	for _, bad := range []string{"50%", "%[x]d", "%[0]d", "%[1]s %[1]d", "%*d", "%[2"} {
		if _, err := Verbs(bad); err == nil {
			t.Errorf("Verbs(%q) accepted", bad)
		}
	}
}

type card struct {
	Title  string
	Sep    string `i18n:"keep"`
	Effect map[string]string
	Inner  struct{ Detail string }
}

func goodCards() (card, card) {
	en := card{Title: "Install %s from %s", Sep: " · ", Effect: map[string]string{"cups": "Print jobs restart.", "docker": "Containers restart."}}
	en.Inner.Detail = "Now: %s"
	ar := card{Title: "تثبيت %s من %s", Sep: " · ", Effect: map[string]string{"cups": "قد تبدأ مهام الطباعة من جديد.", "docker": "ستتوقف الحاويات ثم تعمل من جديد."}}
	ar.Inner.Detail = "الآن: %s"
	return en, ar
}

func TestCheckAcceptsACompleteTable(t *testing.T) {
	en, ar := goodCards()
	if p := Check(en, ar); len(p) != 0 {
		t.Fatalf("complete table reported: %v", p)
	}
}

func TestCheckFindsEveryProblem(t *testing.T) {
	en, ar := goodCards()
	ar.Title = "تثبيت %s"
	ar.Effect = map[string]string{"cups": "Print jobs restart.", "lp": "الطابعة"}
	ar.Inner.Detail = ""
	p := strings.Join(Check(en, ar), "\n")
	for _, want := range []string{
		"Title: format verbs differ",
		`Effect["cups"]: ar is the English text`,
		`Effect["docker"]: missing in ar`,
		`Effect["lp"]: only in ar`,
		"Inner.Detail: empty ar",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("missing %q in:\n%s", want, p)
		}
	}

	_, latin := goodCards()
	latin.Title = "تثبيت %s من Debian %s"
	if p := strings.Join(Check(en, latin), "\n"); !strings.Contains(p, `Title: Latin text "Debian" outside an isolate`) {
		t.Errorf("bare Latin not reported:\n%s", p)
	}
	_, noArabic := goodCards()
	noArabic.Title = "%s · %s"
	if p := strings.Join(Check(en, noArabic), "\n"); !strings.Contains(p, "Title: ar has no Arabic letters") {
		t.Errorf("text without Arabic not reported:\n%s", p)
	}
	if p := Check(en, 3); len(p) != 1 || !strings.Contains(p[0], "different types") {
		t.Errorf("type mismatch: %v", p)
	}
}
