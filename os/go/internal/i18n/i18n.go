// Package i18n holds the per-language card text of the Go tool servers
// (Rafiq M4 contracts §3). Every user-facing card string exists in English
// and Arabic. The language of one jarvis.describe call travels in its
// context. Arabic output marks the line right-to-left and isolates every
// inserted value (package ids, paths, versions), so a left-to-right value
// cannot scramble the sentence around it. Error messages to the model are
// not here: they stay English.
package i18n

import (
	"context"
	"fmt"
	"io"
	"sort"
	"sync"
)

// Lang is a card language.
type Lang string

const (
	EN Lang = "en"
	AR Lang = "ar"
)

// Unicode bidi controls (UAX #9).
const (
	FSI = "\u2068" // first strong isolate
	PDI = "\u2069" // pop directional isolate
	RLM = "\u200f" // right-to-left mark
)

// Parse maps a jarvis.describe lang input to a Lang. "" is the contract
// default (English); anything but "en" and "ar" is refused.
func Parse(s string) (Lang, bool) {
	switch s {
	case "", "en":
		return EN, true
	case "ar":
		return AR, true
	}
	return "", false
}

type ctxKey struct{}

// WithLang returns ctx carrying the card language.
func WithLang(ctx context.Context, l Lang) context.Context {
	return context.WithValue(ctx, ctxKey{}, l)
}

// FromContext is the card language of ctx: Arabic only when asked for.
func FromContext(ctx context.Context) Lang {
	if l, _ := ctx.Value(ctxKey{}).(Lang); l == AR {
		return AR
	}
	return EN
}

// Table is one component's card strings in both languages.
type Table[T any] struct {
	en, ar T
}

// NewTable registers a table pair under a unique name (used by the CI
// completeness gate) and returns it. A duplicate name panics at start-up.
func NewTable[T any](name string, en, ar T) *Table[T] {
	register(Registered{Name: name, EN: en, AR: ar})
	return &Table[T]{en: en, ar: ar}
}

// Get returns the strings for l; anything but Arabic is English.
func (t *Table[T]) Get(l Lang) T {
	if l == AR {
		return t.ar
	}
	return t.en
}

// In returns the strings for the language carried by ctx.
func (t *Table[T]) In(ctx context.Context) T { return t.Get(FromContext(ctx)) }

// Registered is one table pair as the completeness gate sees it.
type Registered struct {
	Name   string
	EN, AR any
}

var (
	regMu  sync.Mutex
	tables = map[string]Registered{}
)

func register(r Registered) {
	regMu.Lock()
	defer regMu.Unlock()
	if _, dup := tables[r.Name]; dup {
		panic("i18n: table " + r.Name + " registered twice")
	}
	tables[r.Name] = r
}

// All returns every registered table, sorted by name.
func All() []Registered {
	regMu.Lock()
	defer regMu.Unlock()
	out := make([]Registered, 0, len(tables))
	for _, r := range tables {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// isolated formats its value with the caller's verb, inside FSI…PDI.
type isolated struct{ v any }

func (x isolated) Format(f fmt.State, verb rune) {
	io.WriteString(f, FSI)
	fmt.Fprintf(f, fmt.FormatString(f, verb), x.v)
	io.WriteString(f, PDI)
}

// Sprintf is fmt.Sprintf for card text. In Arabic the result starts with
// RLM and every non-empty string, error or Stringer argument is wrapped in
// an isolate (numbers are not: they read correctly in both directions).
// English output is exactly fmt.Sprintf's.
func Sprintf(l Lang, format string, args ...any) string {
	if l != AR {
		return fmt.Sprintf(format, args...)
	}
	wrapped := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case string:
			if v == "" {
				wrapped[i] = v
			} else {
				wrapped[i] = isolated{v}
			}
		case error, fmt.Stringer:
			wrapped[i] = isolated{v}
		default:
			wrapped[i] = a
		}
	}
	return RLM + fmt.Sprintf(format, wrapped...)
}

// Iso isolates one raw value placed on an Arabic card without Sprintf
// (a path as a card detail, a device address before " · ").
func Iso(l Lang, s string) string {
	if l != AR || s == "" {
		return s
	}
	return FSI + s + PDI
}
