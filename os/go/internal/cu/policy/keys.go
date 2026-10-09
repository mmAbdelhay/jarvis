package policy

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

// Mods are the modifiers a combo may hold.
type Mods uint8

const (
	ModShift Mods = 1 << iota
	ModCtrl
	ModAlt
)

// Mask is the XKB "depressed" modifier mask for the virtual keyboard's
// keymap (Task 8 maps Shift_L, Control_L, Alt_L to Shift, Control, Mod1).
func (m Mods) Mask() uint32 {
	var v uint32
	if m&ModShift != 0 {
		v |= 1
	}
	if m&ModCtrl != 0 {
		v |= 4
	}
	if m&ModAlt != 0 {
		v |= 8
	}
	return v
}

// Combo is a parsed key combo.
type Combo struct {
	Mods   Mods
	Keysym string // XKB keysym name
}

// MaxTextRunes bounds one type op.
const MaxTextRunes = 2000

const maxComboLen = 64

var namedKeys = map[string]string{
	"enter": "Return", "return": "Return", "tab": "Tab", "escape": "Escape", "esc": "Escape",
	"backspace": "BackSpace", "delete": "Delete", "del": "Delete", "insert": "Insert",
	"home": "Home", "end": "End", "pageup": "Prior", "page_up": "Prior", "pagedown": "Next",
	"page_down": "Next", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
	"space": "space", "minus": "minus", "equal": "equal", "plus": "plus", "comma": "comma",
	"period": "period", "slash": "slash", "backslash": "backslash", "semicolon": "semicolon",
	"apostrophe": "apostrophe", "bracketleft": "bracketleft", "bracketright": "bracketright",
	"grave": "grave",
}

// reservedMods belong to the compositor (labwc binds Super; Super+L locks).
var reservedMods = set("super", "meta", "win", "windows", "logo", "cmd", "command", "hyper",
	"mod4", "altgr", "iso_level3_shift")

// ParseCombo parses "ctrl+shift+s": zero or more of ctrl/control, shift,
// alt (each once) then one key. Desktop shortcuts are refused "excluded".
func ParseCombo(s string) (Combo, error) {
	if s == "" || len(s) > maxComboLen {
		return Combo{}, proto.Errorf(proto.CodeFailed, "a combo is 1-%d characters, like \"ctrl+s\"", maxComboLen)
	}
	parts := strings.Split(strings.ToLower(s), "+")
	var c Combo
	for i, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			return Combo{}, proto.Errorf(proto.CodeFailed, "combo %q has an empty part (write \"plus\" for +)", s)
		}
		if reservedMods[p] {
			return Combo{}, proto.Errorf(proto.CodeExcluded, "%s shortcuts belong to the desktop, not the app", p)
		}
		if i < len(parts)-1 {
			var m Mods
			switch p {
			case "ctrl", "control":
				m = ModCtrl
			case "shift":
				m = ModShift
			case "alt":
				m = ModAlt
			default:
				return Combo{}, proto.Errorf(proto.CodeFailed, "unknown modifier %q (use ctrl, shift, alt)", p)
			}
			if c.Mods&m != 0 {
				return Combo{}, proto.Errorf(proto.CodeFailed, "modifier %q appears twice", p)
			}
			c.Mods |= m
			continue
		}
		sym, ok := keysymFor(p)
		if !ok {
			return Combo{}, proto.Errorf(proto.CodeFailed, "unknown key %q", p)
		}
		c.Keysym = sym
	}
	if err := reservedCombo(c); err != nil {
		return Combo{}, err
	}
	return c, nil
}

func keysymFor(p string) (string, bool) {
	if len(p) == 1 && (p[0] >= 'a' && p[0] <= 'z' || p[0] >= '0' && p[0] <= '9') {
		return p, true
	}
	if len(p) >= 2 && len(p) <= 3 && p[0] == 'f' && p[1] != '0' {
		if n, err := strconv.Atoi(p[1:]); err == nil && n >= 1 && n <= 12 {
			return "F" + p[1:], true
		}
	}
	sym, ok := namedKeys[p]
	return sym, ok
}

// reservedCombo refuses labwc / kernel shortcuts that act outside the
// focused app: ctrl+alt+anything (VT switch, Ctrl+Alt+T terminal,
// Ctrl+Alt+Delete) and alt+Tab/Escape/Space/arrows/F-keys (window
// switching, window menu, snapping, close).
func reservedCombo(c Combo) error {
	if c.Mods&ModCtrl != 0 && c.Mods&ModAlt != 0 {
		return proto.Errorf(proto.CodeExcluded, "ctrl+alt shortcuts belong to the desktop")
	}
	if c.Mods&ModAlt == 0 {
		return nil
	}
	switch c.Keysym {
	case "Tab", "Escape", "space", "Up", "Down", "Left", "Right":
		return proto.Errorf(proto.CodeExcluded, "alt+%s is a window-manager shortcut", strings.ToLower(c.Keysym))
	}
	if len(c.Keysym) > 1 && c.Keysym[0] == 'F' {
		return proto.Errorf(proto.CodeExcluded, "alt+%s is a window-manager shortcut", strings.ToLower(c.Keysym))
	}
	return nil
}

// TextKeysyms validates text for the type op and returns one keysym name
// per rune: "Return" for \n, "Tab" for \t, "U%04X" otherwise (xkbcommon
// maps U0020-U007E and U00A0-U00FF to the legacy Latin-1 keysyms). \r is
// dropped; other control characters are refused.
func TextKeysyms(text string) ([]string, error) {
	if !utf8.ValidString(text) {
		return nil, proto.Errorf(proto.CodeFailed, "text is not valid UTF-8")
	}
	if n := utf8.RuneCountInString(text); n > MaxTextRunes {
		return nil, proto.Errorf(proto.CodeFailed, "text is %d characters; the limit is %d per type", n, MaxTextRunes)
	}
	out := make([]string, 0, len(text))
	for _, r := range text {
		switch {
		case r == '\r':
			continue
		case r == '\n':
			out = append(out, "Return")
		case r == '\t':
			out = append(out, "Tab")
		case r < 0x20 || (r >= 0x7f && r < 0xa0):
			return nil, proto.Errorf(proto.CodeFailed, "text contains control character U+%04X", r)
		default:
			out = append(out, fmt.Sprintf("U%04X", r))
		}
	}
	if len(out) == 0 {
		return nil, proto.Errorf(proto.CodeFailed, "text is empty")
	}
	return out, nil
}
