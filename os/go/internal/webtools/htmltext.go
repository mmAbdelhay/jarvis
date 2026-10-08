package webtools

import (
	"html"
	"strings"
)

// skipTags' content is never text.
var skipTags = map[string]bool{
	"script": true, "style": true, "noscript": true, "template": true,
	"svg": true, "iframe": true, "object": true, "canvas": true,
}

// blockTags end a line (opening and closing).
var blockTags = map[string]bool{
	"p": true, "div": true, "br": true, "li": true, "ul": true, "ol": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"tr": true, "table": true, "section": true, "article": true, "header": true,
	"footer": true, "nav": true, "aside": true, "main": true, "blockquote": true,
	"pre": true, "hr": true, "dd": true, "dt": true, "dl": true, "figure": true,
	"figcaption": true, "form": true, "address": true, "body": true, "html": true,
}

// HTMLText returns an HTML document's title and visible text. It is a
// small forgiving scanner, not a parser: broken markup gives best-effort
// text and it never fails.
func HTMLText(src string) (title, text string) {
	var out, tb strings.Builder
	inTitle := false
	emit := func(s string) {
		if inTitle {
			tb.WriteString(s)
		} else {
			out.WriteString(s)
		}
	}
	for i := 0; i < len(src); {
		if src[i] != '<' {
			j := strings.IndexByte(src[i:], '<')
			if j < 0 {
				j = len(src) - i
			}
			emit(src[i : i+j])
			i += j
			continue
		}
		if strings.HasPrefix(src[i:], "<!--") {
			end := strings.Index(src[i+4:], "-->")
			if end < 0 {
				break
			}
			i += 4 + end + 3
			continue
		}
		var next byte
		if i+1 < len(src) {
			next = src[i+1]
		}
		if !(isLetter(next) || next == '/' || next == '!' || next == '?') {
			emit("<") // "1 < 2": a lone less-than is text
			i++
			continue
		}
		end := tagEnd(src, i+1)
		if end < 0 {
			break
		}
		raw := src[i+1 : end]
		i = end + 1
		name, closing := tagName(raw)
		switch {
		case name == "":
			// <!DOCTYPE>, <?xml?>: nothing
		case name == "title":
			inTitle = !closing
		case skipTags[name]:
			if closing || strings.HasSuffix(raw, "/") {
				break
			}
			k := indexFoldASCII(src[i:], "</"+name)
			if k < 0 {
				i = len(src)
			} else {
				i += k
			}
		case blockTags[name]:
			out.WriteByte('\n')
		case name == "td" || name == "th":
			out.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(html.UnescapeString(tb.String())), " "),
		normalize(html.UnescapeString(out.String()))
}

func isLetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// tagEnd finds the '>' that ends a tag starting at from, skipping '>'
// inside quoted attribute values.
func tagEnd(s string, from int) int {
	var quote byte
	afterEq := false
	for k := from; k < len(s); k++ {
		c := s[k]
		if quote != 0 {
			if c == quote {
				quote, afterEq = 0, false
			}
			continue
		}
		switch {
		case c == '>':
			return k
		case (c == '"' || c == '\'') && afterEq:
			quote = c
			continue
		}
		if c == '=' {
			afterEq = true
		} else if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			afterEq = false
		}
	}
	return -1
}

// tagName returns the lower-case element name of a tag body and whether
// it is a closing tag; "" for <!...> and <?...>.
func tagName(raw string) (string, bool) {
	closing := false
	if strings.HasPrefix(raw, "/") {
		closing, raw = true, raw[1:]
	}
	k := 0
	for k < len(raw) && (isLetter(raw[k]) || (k > 0 && raw[k] >= '0' && raw[k] <= '9')) {
		k++
	}
	return strings.ToLower(raw[:k]), closing
}

// indexFoldASCII finds sub (ASCII) in s ignoring case, by byte offset.
func indexFoldASCII(s, sub string) int {
	n := len(sub)
	for i := 0; ; i++ {
		j := strings.IndexByte(s[i:], '<')
		if j < 0 {
			return -1
		}
		i += j
		if i+n <= len(s) && strings.EqualFold(s[i:i+n], sub) {
			return i
		}
	}
}

// normalize collapses whitespace inside each line and drops empty lines.
func normalize(s string) string {
	var lines []string
	for _, ln := range strings.Split(s, "\n") {
		if ln = strings.Join(strings.Fields(ln), " "); ln != "" {
			lines = append(lines, ln)
		}
	}
	return strings.Join(lines, "\n")
}
