package settingstools

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
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

func TestSettingsCardTableIsComplete(t *testing.T) {
	for _, p := range i18n.Check(cardText.Get(i18n.EN), cardText.Get(i18n.AR)) {
		t.Errorf("cardText.%s", p)
	}
	for _, id := range []string{"power-saver", "balanced", "performance"} {
		if cardText.Get(i18n.AR).Profiles[id] == "" {
			t.Errorf("no Arabic name for power profile %s", id)
		}
	}
}

func TestArabicSettingsCards(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("intel_backlight,backlight,16800,70%,24000\n"), "brightnessctl", "--class=backlight", "-m", "info").
		On(execx.OK("balanced\n"), "powerprofilesctl", "get").
		On(execx.OK("Volume: 0.30\n"), "wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@")
	d, _ := deps(t, run)
	cases := []struct{ tool, args, title string }{
		{"settings.brightness", `{"percent":40}`, i18n.RLM + "ضبط سطوع الشاشة على 40%"},
		{"settings.volume", `{"percent":50,"muted":true}`, i18n.RLM + "ضبط مستوى الصوت على 50% و" + iso("كتمه")},
		{"settings.volume", `{"muted":false}`, "إلغاء كتم الصوت"},
		{"settings.night_light", `{"on":true,"untilHour":7}`, i18n.RLM + "تشغيل الإضاءة الليلية حتى الساعة 07:00"},
		{"settings.night_light", `{"on":false}`, "إيقاف الإضاءة الليلية"},
		{"settings.wifi", `{"on":true}`, "تشغيل الواي فاي"},
		{"settings.bluetooth", `{"on":false}`, "إيقاف البلوتوث"},
		{"settings.power_profile", `{"profile":"power-saver"}`, i18n.RLM + "تغيير وضع الطاقة إلى " + iso("توفير الطاقة")},
		{"settings.scale", `{"output":"eDP-1","scale":1.5}`, i18n.RLM + "ضبط تكبير الشاشة " + iso("eDP-1") + " على 1.5"},
		{"settings.keyboard", `{"layout":"fr","variant":"azerty"}`, i18n.RLM + "تغيير تخطيط لوحة المفاتيح إلى " + iso("fr") + " (" + iso("azerty") + ")"},
	}
	for _, c := range cases {
		got := describeIn(t, d, i18n.AR, c.tool, c.args)
		if got.Title != c.title {
			t.Errorf("%s %s:\n got %q\nwant %q", c.tool, c.args, got.Title, c.title)
		}
		if s := i18n.LatinOutsideIsolates(got.Title + " " + got.Detail); s != "" {
			t.Errorf("%s: bare Latin %q in %+q", c.tool, s, got)
		}
	}
	// The confirm card's detail is the previous/current transition, with the
	// Arabic arrow (Rafiq M4 contracts §6.4); names come from the table.
	want := i18n.RLM + iso("متوازن") + " ← " + iso("الأداء العالي")
	if got := describeIn(t, d, i18n.AR, "settings.power_profile", `{"profile":"performance"}`); got.Detail != want {
		t.Errorf("power profile detail %q, want %q", got.Detail, want)
	}
	if got := describeIn(t, d, i18n.EN, "settings.power_profile", `{"profile":"power-saver"}`); got.Title != "Switch power mode to power-saver" || got.Detail != "balanced → power-saver" {
		t.Errorf("English power card changed: %+v", got)
	}
}
