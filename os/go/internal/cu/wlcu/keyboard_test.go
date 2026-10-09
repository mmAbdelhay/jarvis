package wlcu

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestBuildKeymap(t *testing.T) {
	km, err := BuildKeymap([]string{"U0627", "Return"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<K9> = 9;", "<K13> = 13;", "maximum = 255;",
		"key <K9> { [ Shift_L ] };", "modifier_map Shift { <K9> };",
		"key <K10> { [ Control_L ] };", "modifier_map Control { <K10> };",
		"key <K11> { [ Alt_L ] };", "modifier_map Mod1 { <K11> };",
		"key <K12> { [ U0627 ] };", "key <K13> { [ Return ] };",
		`include "complete"`,
	} {
		if !strings.Contains(km, want) {
			t.Errorf("keymap lacks %q:\n%s", want, km)
		}
	}
	if strings.Contains(km, "<K14>") {
		t.Fatal("keycodes beyond the syms used")
	}
	for _, bad := range [][]string{{"a } ; key <K9> { [ Super_L"}, {""}, {"U0627 "}} {
		if _, err := BuildKeymap(bad); err == nil {
			t.Errorf("BuildKeymap(%q) accepted", bad)
		}
	}
	many := make([]string, MaxSymsPerKeymap+1)
	for i := range many {
		many[i] = fmt.Sprintf("U%04X", 0x600+i)
	}
	if _, err := BuildKeymap(many); err == nil {
		t.Fatal("over capacity accepted")
	}
}

func keyEvents(f *fake) []string {
	var out []string
	for _, l := range f.logged() {
		if strings.HasPrefix(l, "key ") || strings.HasPrefix(l, "mods ") || l == "keymap" {
			out = append(out, l)
		}
	}
	return out
}

func TestTypeArabicAndEmoji(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	k, err := c.NewKeyboard()
	if err != nil {
		t.Fatal(err)
	}
	if err := k.Type([]string{"U0645", "U0631", "U0645", "U1F600"}); err != nil {
		t.Fatal(err)
	}
	// keycode 12 -> evdev 4, 13 -> 5, 14 -> 6
	want := []string{"keymap", "key 4 1", "key 4 0", "key 5 1", "key 5 0", "key 4 1", "key 4 0", "key 6 1", "key 6 0"}
	if got := keyEvents(f); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
	if !strings.Contains(f.keymaps[0], "key <K14> { [ U1F600 ] };") {
		t.Fatal(f.keymaps[0])
	}
	// The same syms again reuse the loaded keymap.
	if err := k.Type([]string{"U0645"}); err != nil {
		t.Fatal(err)
	}
	if f.count("keymap") != 1 {
		t.Fatal("an identical keymap was uploaded twice")
	}
}

func TestTypeSplitsKeymapsBeyondCapacity(t *testing.T) {
	f := newFake()
	c, _ := startFake(t, f, nil)
	k, err := c.NewKeyboard()
	if err != nil {
		t.Fatal(err)
	}
	var syms []string
	for i := 0; i < MaxSymsPerKeymap+10; i++ {
		syms = append(syms, fmt.Sprintf("U%04X", 0x4E00+i))
	}
	if err := k.Type(syms); err != nil {
		t.Fatal(err)
	}
	if f.count("keymap") != 2 || f.count("key ") != 2*len(syms) {
		t.Fatalf("keymaps %d keys %d", f.count("keymap"), f.count("key "))
	}
	// Order is kept across the split: the last key of batch 1 is keycode 255 (evdev 247), then batch 2 starts at 12 (evdev 4).
	ev := keyEvents(f)
	idx := 0
	for i, e := range ev {
		if e == "keymap" && i > 0 {
			idx = i
		}
	}
	if ev[idx-2] != "key 247 1" || ev[idx+1] != "key 4 1" {
		t.Fatalf("split order: %v .. %v", ev[idx-2:idx], ev[idx:idx+2])
	}
}

func TestCombo(t *testing.T) {
	f := newFake()
	c, _ := startFake(t, f, nil)
	k, err := c.NewKeyboard()
	if err != nil {
		t.Fatal(err)
	}
	if err := k.Combo(4|1, "s"); err != nil {
		t.Fatal(err)
	}
	want := []string{"keymap", "mods 5", "key 4 1", "key 4 0", "mods 0"}
	if got := keyEvents(f); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if !strings.Contains(f.keymaps[0], "key <K12> { [ s ] };") {
		t.Fatal(f.keymaps[0])
	}
}
