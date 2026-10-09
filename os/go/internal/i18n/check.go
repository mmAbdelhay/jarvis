package i18n

import (
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Check compares an English and an Arabic table and returns every
// problem as "<path>: <problem>". It is the CI gate of Rafiq M4 contracts
// §3: a missing key, an empty string, an untranslated string, a string
// with no Arabic letters, a bare Latin word outside an isolate, or format
// verbs that differ (which would print %!s(MISSING) on a card) all fail.
// Fields tagged `i18n:"keep"` (proper names, punctuation) may stay as
// they are, but their verbs must still match.
func Check(en, ar any) []string {
	ev, av := reflect.ValueOf(en), reflect.ValueOf(ar)
	if !ev.IsValid() || !av.IsValid() || ev.Type() != av.Type() {
		return []string{fmt.Sprintf("en and ar tables have different types (%T, %T)", en, ar)}
	}
	var out []string
	walk("", ev, av, "", &out)
	return out
}

func walk(path string, en, ar reflect.Value, tag string, out *[]string) {
	switch en.Kind() {
	case reflect.Struct:
		for i := 0; i < en.NumField(); i++ {
			f := en.Type().Field(i)
			p := f.Name
			if path != "" {
				p = path + "." + f.Name
			}
			walk(p, en.Field(i), ar.Field(i), f.Tag.Get("i18n"), out)
		}
	case reflect.Map:
		if en.Type().Key().Kind() != reflect.String || en.Type().Elem().Kind() != reflect.String {
			*out = append(*out, path+": only map[string]string maps are supported")
			return
		}
		keys := map[string]bool{}
		for _, k := range en.MapKeys() {
			keys[k.String()] = true
		}
		for _, k := range ar.MapKeys() {
			keys[k.String()] = true
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			p := fmt.Sprintf("%s[%q]", path, k)
			key := reflect.ValueOf(k).Convert(en.Type().Key())
			ev, av := en.MapIndex(key), ar.MapIndex(key)
			switch {
			case !ev.IsValid():
				*out = append(*out, p+": only in ar")
			case !av.IsValid():
				*out = append(*out, p+": missing in ar")
			default:
				walk(p, ev, av, tag, out)
			}
		}
	case reflect.String:
		checkString(path, en.String(), ar.String(), tag, out)
	default:
		*out = append(*out, fmt.Sprintf("%s: unsupported kind %s (use strings, structs and map[string]string)", path, en.Kind()))
	}
}

func checkString(path, en, ar, tag string, out *[]string) {
	add := func(format string, a ...any) { *out = append(*out, path+": "+fmt.Sprintf(format, a...)) }
	if strings.TrimSpace(en) == "" {
		add("empty en")
	}
	if strings.TrimSpace(ar) == "" {
		add("empty ar")
		return
	}
	ev, _, enErr := scan(en)
	av, lit, arErr := scan(ar)
	switch {
	case enErr != nil:
		add("en format: %v", enErr)
	case arErr != nil:
		add("ar format: %v", arErr)
	case !reflect.DeepEqual(ev, av):
		add("format verbs differ: en %v, ar %v", ev, av)
	}
	if tag == "keep" {
		return
	}
	if ar == en {
		add("ar is the English text (untranslated)")
		return
	}
	if !hasArabic(ar) {
		add("ar has no Arabic letters")
	}
	if s := LatinOutsideIsolates(lit); s != "" {
		add("Latin text %q outside an isolate", s)
	}
}

func hasArabic(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Arabic, r) {
			return true
		}
	}
	return false
}

// LatinOutsideIsolates returns the first run of ASCII letters that is not
// inside an LRI/RLI/FSI…PDI isolate, or "". An unterminated isolate runs
// to the end of the string.
func LatinOutsideIsolates(s string) string {
	depth := 0
	for i, r := range s {
		switch r {
		case '\u2066', '\u2067', '\u2068':
			depth++
			continue
		case '\u2069':
			if depth > 0 {
				depth--
			}
			continue
		}
		if depth == 0 && r < utf8.RuneSelf && unicode.IsLetter(r) {
			j := i
			for j < len(s) && s[j] < utf8.RuneSelf && unicode.IsLetter(rune(s[j])) {
				j++
			}
			return s[i:j]
		}
	}
	return ""
}

// Verbs maps each argument number (1-based) of a fmt format to its
// conversion without the index, e.g. "%5[2]d %[1]s" → {1:"s", 2:"5d"}.
func Verbs(format string) (map[int]string, error) {
	v, _, err := scan(format)
	return v, err
}

// scan parses a fmt format the way fmt does (flags, [n] before or after
// width/precision, verb) and also returns the text with every conversion
// removed (for the Latin-letter check).
func scan(format string) (map[int]string, string, error) {
	verbs := map[int]string{}
	var lit strings.Builder
	arg := 1
	for i := 0; i < len(format); i++ {
		c := format[i]
		if c != '%' {
			lit.WriteByte(c)
			continue
		}
		start := i
		i++
		if i >= len(format) {
			return nil, "", fmt.Errorf("lone %% at the end")
		}
		if format[i] == '%' {
			lit.WriteByte('%')
			continue
		}
		var spec strings.Builder
		for i < len(format) && strings.IndexByte("+-# 0", format[i]) >= 0 {
			spec.WriteByte(format[i])
			i++
		}
		index := func() error {
			if i < len(format) && format[i] == '[' {
				end := strings.IndexByte(format[i:], ']')
				if end < 0 {
					return fmt.Errorf("unclosed [ in the conversion at byte %d", start)
				}
				n, err := strconv.Atoi(format[i+1 : i+end])
				if err != nil || n < 1 {
					return fmt.Errorf("bad argument index in the conversion at byte %d", start)
				}
				arg = n
				i += end + 1
			}
			return nil
		}
		if err := index(); err != nil {
			return nil, "", err
		}
		for i < len(format) && (format[i] >= '0' && format[i] <= '9' || format[i] == '.') {
			spec.WriteByte(format[i])
			i++
		}
		if err := index(); err != nil {
			return nil, "", err
		}
		if i >= len(format) {
			return nil, "", fmt.Errorf("the conversion at byte %d has no verb", start)
		}
		v := format[i]
		if !(v >= 'a' && v <= 'z' || v >= 'A' && v <= 'Z') {
			return nil, "", fmt.Errorf("the conversion at byte %d has no verb (found %q)", start, v)
		}
		spec.WriteByte(v)
		if prev, ok := verbs[arg]; ok && prev != spec.String() {
			return nil, "", fmt.Errorf("argument %d is formatted both as %%%s and %%%s", arg, prev, spec.String())
		}
		verbs[arg] = spec.String()
		arg++
	}
	return verbs, lit.String(), nil
}
