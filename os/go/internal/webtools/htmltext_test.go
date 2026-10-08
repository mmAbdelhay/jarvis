package webtools

import "testing"

func TestHTMLText(t *testing.T) {
	cases := []struct {
		name, src, title, text string
	}{
		{
			name:  "document",
			src:   `<!DOCTYPE html><html><head><title>Hello &amp; welcome</title><style>p{color:red}</style></head><body><h1>News</h1><p>First <b>bold</b> line.</p><script>if (a<b) { x = "</p>" }</script><p>Second&nbsp;line</p></body></html>`,
			title: "Hello & welcome",
			text:  "News\nFirst bold line.\nSecond line",
		},
		{name: "comment", src: `a<!-- hidden <p>x</p> -->b`, text: "ab"},
		{name: "lone less-than", src: `<p>1 < 2 and 3 > 2</p>`, text: "1 < 2 and 3 > 2"},
		{name: "quoted greater-than", src: `<a title="x > y" href='/z'>link</a> end`, text: "link end"},
		{name: "unclosed script", src: `<p>ok</p><script>var a = 1;`, text: "ok"},
		{name: "table", src: `<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>`, text: "a b\nc"},
		{name: "case and entities", src: `<P>caf&eacute; &#x263A;</P><BR>end`, text: "café ☺\nend"},
		{name: "processing instruction", src: `<?xml version="1.0"?><!DOCTYPE html>text`, text: "text"},
		{name: "svg", src: `<svg><text>hidden</text></svg>visible`, text: "visible"},
		{name: "uppercase script close", src: `<SCRIPT>evil()</SCRIPT>shown`, text: "shown"},
		{name: "self-closing script", src: `<script src="x.js"/>after`, text: "after"},
		{name: "unterminated comment", src: `before<!-- never closed`, text: "before"},
		{name: "unterminated tag", src: `before<p class="x`, text: "before"},
		{name: "title only", src: `<title>  Spaced
  Title </title>`, title: "Spaced Title"},
		{name: "list", src: `<ul><li>one</li><li>two</li></ul>`, text: "one\ntwo"},
	}
	for _, c := range cases {
		title, text := HTMLText(c.src)
		if title != c.title || text != c.text {
			t.Errorf("%s:\n got title %q text %q\nwant title %q text %q", c.name, title, text, c.title, c.text)
		}
	}
}
