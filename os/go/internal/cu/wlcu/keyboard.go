package wlcu

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

const (
	kcShift = 9
	kcCtrl  = 10
	kcAlt   = 11
	kcFirst = 12
	kcLast  = 255
	// MaxSymsPerKeymap is how many distinct keysyms one keymap holds.
	MaxSymsPerKeymap = kcLast - kcFirst + 1
)

var symRe = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

// BuildKeymap writes an XKB keymap with Shift_L/Control_L/Alt_L at
// keycodes 9–11 and syms[i] at keycode 12+i, level 1 (a lowercase letter
// also has its capital at level 2).
func BuildKeymap(syms []string) (string, error) {
	if len(syms) > MaxSymsPerKeymap {
		return "", fmt.Errorf("wlcu: %d keysyms do not fit one keymap", len(syms))
	}
	for _, s := range syms {
		if !symRe.MatchString(s) {
			return "", fmt.Errorf("wlcu: bad keysym name %q", s)
		}
	}
	var b strings.Builder
	b.WriteString("xkb_keymap {\nxkb_keycodes \"jarvis\" {\nminimum = 8;\nmaximum = 255;\n")
	for kc := kcShift; kc < kcFirst+len(syms); kc++ {
		fmt.Fprintf(&b, "<K%d> = %d;\n", kc, kc)
	}
	b.WriteString("};\nxkb_types \"jarvis\" { include \"complete\" };\n")
	b.WriteString("xkb_compatibility \"jarvis\" { include \"complete\" };\n")
	b.WriteString("xkb_symbols \"jarvis\" {\n")
	b.WriteString("key <K9> { [ Shift_L ] };\nmodifier_map Shift { <K9> };\n")
	b.WriteString("key <K10> { [ Control_L ] };\nmodifier_map Control { <K10> };\n")
	b.WriteString("key <K11> { [ Alt_L ] };\nmodifier_map Mod1 { <K11> };\n")
	for i, s := range syms {
		// A lowercase ASCII letter gets its capital on the Shift level, as on
		// a real keyboard: GTK3 accelerators such as GIMP's Shift+Ctrl+E only
		// match when Shift turns e into E.
		if len(s) == 1 && s[0] >= 'a' && s[0] <= 'z' {
			fmt.Fprintf(&b, "key <K%d> { [ %s, %s ] };\n", kcFirst+i, s, strings.ToUpper(s))
			continue
		}
		fmt.Fprintf(&b, "key <K%d> { [ %s ] };\n", kcFirst+i, s)
	}
	b.WriteString("};\n};\n")
	return b.String(), nil
}

// Keyboard is a virtual keyboard.
type Keyboard struct {
	c      *Client
	id     uint32
	start  time.Time
	loaded []string
}

// NewKeyboard creates a virtual keyboard on the seat.
func (c *Client) NewKeyboard() (*Keyboard, error) {
	c.mu.Lock()
	id := c.newID(kindVKeyboard)
	mgr, seat := c.ids[kindVKeyboardMgr], c.ids[kindSeat]
	c.mu.Unlock()
	if err := c.send(msg(mgr, opVKMgrCreate, seat, id), nil); err != nil {
		return nil, err
	}
	if err := c.roundtrip(); err != nil {
		return nil, err
	}
	return &Keyboard{c: c, id: id, start: time.Now()}, nil
}

func (k *Keyboard) ms() uint32 { return uint32(time.Since(k.start).Milliseconds()) }

// ensure makes every sym available, reusing the loaded keymap when it
// already holds them all, and returns each sym's keycode.
func (k *Keyboard) ensure(syms []string) (map[string]int, error) {
	pos := map[string]int{}
	for i, s := range k.loaded {
		pos[s] = kcFirst + i
	}
	have := k.loaded != nil
	for _, s := range syms {
		if _, ok := pos[s]; !ok {
			have = false
		}
	}
	if have {
		return pos, nil
	}
	text, err := BuildKeymap(syms)
	if err != nil {
		return nil, err
	}
	data := append([]byte(text), 0)
	shm, err := k.c.shmAlloc.Alloc(len(data))
	if err != nil {
		return nil, err
	}
	defer shm.Close()
	copy(shm.Mem, data)
	if err := k.c.send(msg(k.id, opVKKeymap, keymapFormatXKBv1, uint32(len(data))), []int{shm.FD}); err != nil {
		return nil, err
	}
	if err := k.c.roundtrip(); err != nil {
		return nil, err
	}
	k.loaded = slices.Clone(syms)
	pos = map[string]int{}
	for i, s := range syms {
		pos[s] = kcFirst + i
	}
	return pos, nil
}

func (k *Keyboard) tap(keycode int, mask uint32) error {
	t := k.ms()
	var ms []wl.Message
	if mask != 0 {
		ms = append(ms, msg(k.id, opVKModifiers, mask, 0, 0, 0))
	}
	ms = append(ms, msg(k.id, opVKKey, t, uint32(keycode-8), 1), msg(k.id, opVKKey, t+1, uint32(keycode-8), 0))
	if mask != 0 {
		ms = append(ms, msg(k.id, opVKModifiers, 0, 0, 0, 0))
	}
	if err := k.c.sendAll(ms...); err != nil {
		return err
	}
	return k.c.roundtrip()
}

// Type presses and releases each keysym in order.
func (k *Keyboard) Type(syms []string) error {
	// Validate the entire sequence before sending input, including names
	// that would otherwise be checked only after a keymap boundary.
	for _, s := range syms {
		if !symRe.MatchString(s) {
			return fmt.Errorf("wlcu: invalid keysym name")
		}
	}
	for len(syms) > 0 {
		var uniq []string
		seen := map[string]bool{}
		n := 0
		for n < len(syms) {
			s := syms[n]
			if !seen[s] {
				if len(uniq) == MaxSymsPerKeymap {
					break
				}
				seen[s] = true
				uniq = append(uniq, s)
			}
			n++
		}
		pos, err := k.ensure(uniq)
		if err != nil {
			return err
		}
		for _, s := range syms[:n] {
			if err := k.tap(pos[s], 0); err != nil {
				return err
			}
		}
		syms = syms[n:]
	}
	return nil
}

// Combo presses keysym with the XKB depressed modifier mask held.
func (k *Keyboard) Combo(mask uint32, keysym string) error {
	pos, err := k.ensure([]string{keysym})
	if err != nil {
		return err
	}
	return k.tap(pos[keysym], mask)
}

// Prime uploads a keymap without pressing anything, so the keyboard is a
// complete seat device from the start.
func (k *Keyboard) Prime() error {
	_, err := k.ensure([]string{"space"})
	return err
}

// Close destroys the virtual keyboard.
func (k *Keyboard) Close() error { return k.c.send(msg(k.id, opVKDestroy), nil) }
