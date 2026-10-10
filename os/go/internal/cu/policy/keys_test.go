package policy

import (
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

func TestParseComboAccepts(t *testing.T) {
	cases := map[string]Combo{
		"ctrl+s":        {ModCtrl, "s"},
		"Ctrl+Shift+S":  {ModCtrl | ModShift, "s"},
		"control+z":     {ModCtrl, "z"},
		"enter":         {0, "Return"},
		"esc":           {0, "Escape"},
		"shift+tab":     {ModShift, "Tab"},
		"alt+f":         {ModAlt, "f"},
		"f2":            {0, "F2"},
		"F12":           {0, "F12"},
		"ctrl+pagedown": {ModCtrl, "Next"},
		"ctrl+minus":    {ModCtrl, "minus"},
		"ctrl+plus":     {ModCtrl, "plus"},
		" ctrl + a ":    {ModCtrl, "a"},
		"delete":        {0, "Delete"},
		"ctrl+0":        {ModCtrl, "0"},
	}
	for in, want := range cases {
		got, err := ParseCombo(in)
		if err != nil || got != want {
			t.Errorf("ParseCombo(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
}

func TestParseComboRefuses(t *testing.T) {
	cases := map[string]string{
		"super+l":               proto.CodeExcluded,
		"meta+a":                proto.CodeExcluded,
		"logo":                  proto.CodeExcluded,
		"ctrl+alt+t":            proto.CodeExcluded,
		"ctrl+alt+f2":           proto.CodeExcluded,
		"ctrl+alt+delete":       proto.CodeExcluded,
		"alt+tab":               proto.CodeExcluded,
		"alt+shift+tab":         proto.CodeExcluded,
		"alt+f4":                proto.CodeExcluded,
		"alt+f3":                proto.CodeExcluded,
		"alt+space":             proto.CodeExcluded,
		"alt+escape":            proto.CodeExcluded,
		"alt+left":              proto.CodeExcluded,
		"":                      proto.CodeFailed,
		"ctrl+":                 proto.CodeFailed,
		"ctrl+ctrl+s":           proto.CodeFailed,
		"hyperdrive":            proto.CodeFailed,
		"ctrl+print":            proto.CodeFailed,
		"xf86audiomute":         proto.CodeFailed,
		"f13":                   proto.CodeFailed,
		"f0":                    proto.CodeFailed,
		"s+ctrl":                proto.CodeFailed,
		strings.Repeat("a", 65): proto.CodeFailed,
	}
	for in, code := range cases {
		_, err := ParseCombo(in)
		if err == nil || proto.AsError(err).Code != code {
			t.Errorf("ParseCombo(%q) = %v, want code %s", in, err, code)
		}
	}
}

func TestModsMask(t *testing.T) {
	if (ModShift|ModCtrl|ModAlt).Mask() != 1|4|8 || Mods(0).Mask() != 0 {
		t.Fatal("XKB mask bits are Shift=1 Control=4 Mod1=8")
	}
}

func TestTextKeysyms(t *testing.T) {
	got, err := TextKeysyms("Hi\tا\r\n😀")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"U0048", "U0069", "Tab", "U0627", "Return", "U1F600"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestTextKeysymsRefuses(t *testing.T) {
	for name, in := range map[string]string{
		"empty":    "",
		"only cr":  "\r",
		"escape":   "a\x1bb",
		"nul":      "a\x00",
		"del":      "a\x7f",
		"c1":       "a\u0085",
		"bad utf8": "a\xffb",
		"too long": strings.Repeat("x", MaxTextRunes+1),
	} {
		if _, err := TextKeysyms(in); err == nil || proto.AsError(err).Code != proto.CodeFailed {
			t.Errorf("%s: want failed, got %v", name, err)
		}
	}
	if _, err := TextKeysyms(strings.Repeat("ب", MaxTextRunes)); err != nil {
		t.Fatalf("exactly MaxTextRunes must pass: %v", err)
	}
}
