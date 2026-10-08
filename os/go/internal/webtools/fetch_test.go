package webtools

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func fetch(t *testing.T, d Deps, args string) (map[string]any, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == "web.fetch" {
			v, err := tool.Call(context.Background(), json.RawMessage(args))
			if err != nil {
				return nil, err
			}
			b, _ := json.Marshal(v)
			var m map[string]any
			json.Unmarshal(b, &m)
			return m, nil
		}
	}
	t.Fatal("no web.fetch")
	return nil, nil
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

func urlArg(u string) string { b, _ := json.Marshal(map[string]string{"url": u}); return string(b) }

// loopbackOnly lets tests reach their own httptest servers.
func loopbackOnly(ap netip.AddrPort) bool { return ap.Addr().IsLoopback() }

func TestToolsMatchContract(t *testing.T) {
	var got []string
	for _, tool := range Tools(Deps{}) {
		if tool.Risk != mcp.RiskSafe || tool.Hidden || len(tool.Secrets) != 0 {
			t.Errorf("%s must be a plain safe tool (contracts §3)", tool.Name)
		}
		got = append(got, tool.Name)
	}
	if !reflect.DeepEqual(got, []string{"web.fetch"}) {
		t.Fatalf("tools %v", got)
	}
	if Manifest.ID != "jarvis-web" || !Manifest.Permissions.Network || len(Manifest.Permissions.Paths) != 0 {
		t.Fatalf("manifest %+v", Manifest)
	}
}

func TestPublicOnly(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8:443":                true,
		"1.1.1.1:80":                 true,
		"[2606:4700:4700::1111]:443": true,
		"[64:ff9b::808:808]:443":     true,  // NAT64 of 8.8.8.8
		"127.0.0.1:11434":            false, // local Ollama
		"10.1.2.3:80":                false,
		"172.16.0.1:80":              false,
		"192.168.1.1:80":             false, // the router
		"169.254.169.254:80":         false, // cloud metadata
		"100.64.1.1:80":              false, // carrier-grade NAT
		"0.0.0.0:80":                 false,
		"224.0.0.1:80":               false,
		"255.255.255.255:80":         false,
		"198.18.0.1:80":              false,
		"[::1]:80":                   false,
		"[::]:80":                    false,
		"[fe80::1]:80":               false,
		"[fd00::1]:80":               false,
		"[::ffff:127.0.0.1]:80":      false, // IPv4-mapped loopback
		"[64:ff9b::a00:1]:80":        false, // NAT64 of 10.0.0.1
		"[2002:c0a8:101::1]:80":      false, // 6to4
	} {
		if got := PublicOnly(netip.MustParseAddrPort(addr)); got != want {
			t.Errorf("%s: %v, want %v", addr, got, want)
		}
	}
}

func TestFetchRefusesLoopbackByDefault(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte("local secret"))
	}))
	defer srv.Close()
	_, err := fetch(t, Deps{}, urlArg(srv.URL+"/api/tags"))
	if codeOf(err) != mcp.CodeNotAllowed {
		t.Fatalf("err = %v", err)
	}
	if hits.Load() != 0 {
		t.Fatal("a refused address must never receive a request")
	}
}

func TestRedirectToAPrivateAddressIsBlocked(t *testing.T) {
	var privateHits atomic.Int32
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		privateHits.Add(1)
	}))
	defer private.Close()
	public := httptest.NewServer(http.RedirectHandler(private.URL+"/admin", http.StatusFound))
	defer public.Close()
	publicPort := netip.MustParseAddrPort(strings.TrimPrefix(public.URL, "http://")).Port()
	// Only the "public" server's port counts as public in this test.
	d := Deps{Allow: func(ap netip.AddrPort) bool { return ap.Port() == publicPort }}
	if _, err := fetch(t, d, urlArg(public.URL)); codeOf(err) != mcp.CodeNotAllowed {
		t.Fatalf("err = %v", err)
	}
	if privateHits.Load() != 0 {
		t.Fatal("the redirect target must never be contacted")
	}
}

func TestFetchHTMLPage(t *testing.T) {
	var ua string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ua = r.Header.Get("User-Agent")
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("no cookies or credentials may be sent")
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<html><head><title>Weather</title></head><body><p>Sunny, 24°C</p><script>steal()</script></body></html>`))
	}))
	defer srv.Close()
	m, err := fetch(t, Deps{Allow: loopbackOnly, UserAgent: "Jarvis-Web/test"}, urlArg(srv.URL+"/today#top"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"url": srv.URL + "/today", "finalUrl": srv.URL + "/today", "status": float64(200),
		"contentType": "text/html", "title": "Weather", "text": "Sunny, 24°C", "truncated": false, "skipped": ""}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("got  %v\nwant %v", m, want)
	}
	if ua != "Jarvis-Web/test" {
		t.Fatalf("user agent %q", ua)
	}
}

func TestFetchOverTLS(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("hello over tls"))
	}))
	defer srv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	m, err := fetch(t, Deps{Allow: loopbackOnly, TLSConfig: &tls.Config{RootCAs: pool}}, urlArg(srv.URL))
	if err != nil || m["text"] != "hello over tls" {
		t.Fatalf("%v %v", m, err)
	}
}

func TestFetchCapsAndKinds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/huge":
			w.Header().Set("Content-Type", "text/plain")
			chunk := []byte(strings.Repeat("a", 1<<16))
			for i := 0; i < 48; i++ { // 3 MiB
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
		case "/long":
			w.Header().Set("Content-Type", "text/plain")
			w.Write([]byte(strings.Repeat("é", 1500)))
		case "/png":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte("\x89PNG\r\n\x1a\n"))
		case "/latin1":
			w.Header().Set("Content-Type", "text/plain; charset=ISO-8859-1")
			w.Write([]byte("caf\xe9"))
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"temp":24}`))
		case "/missing":
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte("<p>Not here</p>"))
		}
	}))
	defer srv.Close()
	d := Deps{Allow: loopbackOnly}

	m, err := fetch(t, d, `{"url":"`+srv.URL+`/huge","maxChars":100000}`)
	if err != nil || m["truncated"] != true || len(m["text"].(string)) != 100000 {
		t.Fatalf("huge: %v len=%d", err, len(m["text"].(string)))
	}
	m, _ = fetch(t, d, `{"url":"`+srv.URL+`/long","maxChars":1000}`)
	if m["truncated"] != true || utf8.RuneCountInString(m["text"].(string)) != 1000 || !utf8.ValidString(m["text"].(string)) {
		t.Fatalf("long: %v", m["truncated"])
	}
	m, _ = fetch(t, d, urlArg(srv.URL+"/png"))
	if m["skipped"] != "not text" || m["text"] != "" {
		t.Fatalf("png: %v", m)
	}
	m, _ = fetch(t, d, urlArg(srv.URL+"/latin1"))
	if m["text"] != "café" {
		t.Fatalf("latin1: %q", m["text"])
	}
	m, _ = fetch(t, d, urlArg(srv.URL+"/json"))
	if m["text"] != `{"temp":24}` || m["contentType"] != "application/json" {
		t.Fatalf("json: %v", m)
	}
	m, _ = fetch(t, d, urlArg(srv.URL+"/missing"))
	if m["status"] != float64(404) || m["text"] != "Not here" {
		t.Fatalf("404 page: %v", m)
	}
}

func TestFetchInputRefusals(t *testing.T) {
	for _, args := range []string{
		urlArg("file:///etc/passwd"),
		urlArg("ftp://example.org/x"),
		urlArg("javascript:alert(1)"),
		urlArg("https://user:pw@example.org/"),
		urlArg("https:///nohost"),
		urlArg(""),
		urlArg("https://example.org/" + strings.Repeat("a", 2050)),
		`{"url":"https://example.org","maxChars":5}`,
		`{"url":"https://example.org","cookies":"x"}`,
	} {
		if _, err := fetch(t, Deps{}, args); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", args, err)
		}
	}
}
