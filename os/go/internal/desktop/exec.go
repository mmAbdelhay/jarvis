package desktop

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrBadExec: the Exec line breaks the spec's quoting rules.
	ErrBadExec = errors.New("the app's launcher line is malformed")
	// ErrNoFiles: files were given but the app takes none.
	ErrNoFiles = errors.New("this app does not open files")
)

// splitExec splits an Exec value into words following the spec: words are
// separated by spaces; a double-quoted word may contain spaces, and inside
// quotes \" \` \$ \\ are escapes.
func splitExec(v string) ([]string, error) {
	v = unescape(v)
	var words []string
	var cur strings.Builder
	inWord, quoted := false, false
	for i := 0; i < len(v); i++ {
		ch := v[i]
		switch {
		case quoted && ch == '\\' && i+1 < len(v) && strings.ContainsRune("\"`$\\", rune(v[i+1])):
			cur.WriteByte(v[i+1])
			i++
		case quoted && ch == '"':
			quoted = false
		case quoted:
			cur.WriteByte(ch)
		case ch == '"':
			quoted, inWord = true, true
		case ch == ' ' || ch == '\t':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteByte(ch)
			inWord = true
		}
	}
	if quoted {
		return nil, ErrBadExec
	}
	if inWord {
		words = append(words, cur.String())
	}
	if len(words) == 0 {
		return nil, ErrBadExec
	}
	return words, nil
}

// ExpandExec turns e.Exec into an argv, putting targets (absolute file
// paths or URLs) where the field codes say. %f/%u take the first target,
// %F/%U all of them; %i, %c and %k expand as the spec says; deprecated
// codes vanish. Giving targets to an app without a file code is ErrNoFiles.
func ExpandExec(e Entry, targets []string) ([]string, error) {
	words, err := splitExec(e.Exec)
	if err != nil {
		return nil, err
	}
	var argv []string
	used := false
	for wi, w := range words {
		if w == "%F" || w == "%U" {
			argv = append(argv, targets...)
			used = true
			continue
		}
		if w == "%i" {
			if e.Icon != "" {
				argv = append(argv, "--icon", e.Icon)
			}
			continue
		}
		var b strings.Builder
		drop := false
		for i := 0; i < len(w); i++ {
			if w[i] != '%' {
				b.WriteByte(w[i])
				continue
			}
			if i+1 >= len(w) {
				return nil, ErrBadExec
			}
			i++
			switch w[i] {
			case '%':
				b.WriteByte('%')
			case 'f', 'u':
				used = true
				if len(targets) == 0 {
					drop = b.Len() == 0 && i == len(w)-1
				} else {
					b.WriteString(targets[0])
				}
			case 'c':
				b.WriteString(e.Name)
			case 'k':
				b.WriteString(e.Path)
			case 'd', 'D', 'n', 'N', 'v', 'm':
				drop = b.Len() == 0 && i == len(w)-1
			case 'F', 'U', 'i':
				return nil, fmt.Errorf("%w: %%%c must be a word of its own", ErrBadExec, w[i])
			default:
				return nil, fmt.Errorf("%w: unknown field code %%%c", ErrBadExec, w[i])
			}
		}
		if drop {
			continue
		}
		if wi == 0 && b.Len() == 0 {
			return nil, ErrBadExec
		}
		argv = append(argv, b.String())
	}
	if len(targets) > 0 && !used {
		return nil, ErrNoFiles
	}
	if len(argv) == 0 || argv[0] == "" {
		return nil, ErrBadExec
	}
	return argv, nil
}
