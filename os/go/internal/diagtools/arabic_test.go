package diagtools

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func iso(s string) string { return i18n.FSI + s + i18n.PDI }

func TestArabicDiagCards(t *testing.T) {
	cases := []struct {
		tool, input   string
		title, detail string
	}{
		{"svc.restart", `{"unit":"NetworkManager"}`, i18n.RLM + "إعادة تشغيل " + iso("NetworkManager"), "سينقطع الاتصال بالشبكة لبضع ثوانٍ."},
		{"svc.restart", `{"unit":"pipewire.service","scope":"user"}`, i18n.RLM + "إعادة تشغيل خدمتك " + iso("pipewire"), "ستتوقف الخدمة ثم تعمل من جديد."},
		{"net.connection_up", `{"id":"Home"}`, i18n.RLM + "الاتصال بالشبكة " + iso("Home"), i18n.RLM + "تفعيل اتصال الشبكة المحفوظ " + iso(`"Home"`) + "."},
		{"net.wifi_connect", `{"ssid":"Cafe"}`, i18n.RLM + "الاتصال بشبكة الواي فاي " + iso(`"Cafe"`), "سينضم جارفيس إلى هذه الشبكة. إن احتاجت إلى كلمة مرور فاكتبها هنا؛ فهي تذهب مباشرة إلى مدير الشبكة ولا تُعرض على المساعد أبدًا."},
		{"net.radio_on", `{}`, "تشغيل الواي فاي", "الواي فاي مُطفأ برمجيًا، وهذا يعيد تشغيله."},
	}
	for _, c := range cases {
		d, err := tool(t, Deps{}, c.tool).Describe(i18n.WithLang(context.Background(), i18n.AR), json.RawMessage(c.input))
		if err != nil || d.Title != c.title || d.Detail != c.detail {
			t.Errorf("%s %s:\n got %+q, %v\nwant %q / %q", c.tool, c.input, d, err, c.title, c.detail)
		}
		if i18n.LatinOutsideIsolates(d.Title+d.Detail) != "" {
			t.Errorf("%s: bare Latin in %+v", c.tool, d)
		}
		if d.Source != mcp.SourceSystem && d.Source != mcp.SourceNetwork {
			t.Errorf("%s: source %q", c.tool, d.Source)
		}
	}
}
