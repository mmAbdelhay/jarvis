package admintools

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
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

func TestAdminCardTableIsComplete(t *testing.T) {
	for _, p := range i18n.Check(cardText.Get(i18n.EN), cardText.Get(i18n.AR)) {
		t.Errorf("cardText.%s", p)
	}
}

// The Arabic card must say exactly what the English one says: which
// account, whether the home folder survives, which drive is erased, and
// that the administrator password is asked.
func TestArabicAdminCards(t *testing.T) {
	d := Deps{Run: &execx.Fake{}, Helper: &helperapi.Fake{}}
	pw := " تُطلب كلمة مرور المدير في كل مرة."
	cases := []struct{ tool, args, title, detail string }{
		{"users.add", `{"username":"sara","fullName":"Sara Ali"}`,
			i18n.RLM + "إضافة المستخدم " + iso("sara") + " (" + iso("Sara Ali") + ")",
			"حساب عادي دون صلاحيات المدير، بكلمة المرور التي تختارها." + pw},
		{"users.remove", `{"username":"sara","keepHome":true}`,
			i18n.RLM + "حذف المستخدم " + iso("sara"), "سيُحتفظ بمجلده الشخصي." + pw},
		{"users.remove", `{"username":"sara"}`,
			i18n.RLM + "حذف المستخدم " + iso("sara"), "سيُحذف مجلده الشخصي وكل ملفاته." + pw},
		{"disks.format_removable", `{"device":"/dev/sdb","fs":"exfat","label":"USB"}`,
			i18n.RLM + "مسح " + iso("/dev/sdb") + " وتهيئته بنظام " + iso("exfat"),
			i18n.RLM + "سيضيع كل ما على " + iso("/dev/sdb") + "." + pw},
		{"disks.mount", `{"device":"/dev/sdb1"}`, i18n.RLM + "فتح القرص " + iso("/dev/sdb1"), "قرص قابل للإزالة"},
		{"disks.unmount", `{"device":"/dev/sdb1"}`, i18n.RLM + "إخراج القرص " + iso("/dev/sdb1") + " بأمان", "قرص قابل للإزالة"},
	}
	for _, c := range cases {
		got := describeIn(t, d, i18n.AR, c.tool, c.args)
		if got.Title != c.title || got.Detail != c.detail {
			t.Errorf("%s %s:\n got %q / %q\nwant %q / %q", c.tool, c.args, got.Title, got.Detail, c.title, c.detail)
		}
	}
}

func TestArabicDriveNameUsesArabicUnits(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(`{"blockdevices":[{"model":null,"size":32000000000}]}`),
		"lsblk", "--json", "--bytes", "--nodeps", "--output", "MODEL,SIZE", "--", "/dev/sdb")
	got := describeIn(t, Deps{Run: run, Helper: &helperapi.Fake{}}, i18n.AR, "disks.format_removable", `{"device":"/dev/sdb","fs":"exfat","label":"USB"}`)
	want := i18n.RLM + "سيضيع كل ما على " + iso("/dev/sdb ("+i18n.RLM+iso("هذا القرص")+"، 32 غيغابايت)") + "." + " تُطلب كلمة مرور المدير في كل مرة."
	if got.Detail != want {
		t.Fatalf("drive name\n got %q\nwant %q", got.Detail, want)
	}
}
