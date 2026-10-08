package pkgtools

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry/registrytest"
)

type fakeRegistry struct {
	srv   *httptest.Server
	mu    sync.Mutex
	files map[string][]byte
	count map[string]int
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	t.Helper()
	fr := &fakeRegistry{files: map[string][]byte{}, count: map[string]int{}}
	fr.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fr.mu.Lock()
		b, ok := fr.files[r.URL.Path]
		fr.count[r.URL.Path]++
		fr.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(fr.srv.Close)
	return fr
}

func (fr *fakeRegistry) put(path string, b []byte) {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	fr.files[path] = b
}

func (fr *fakeRegistry) hits(path string) int {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	return fr.count[path]
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func artifactBytes(t *testing.T, body []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := registry.Pack(&b, []registry.PackFile{{Name: "server", Mode: 0o755, Data: body}}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// entry serves art and returns a go-static entry pointing at it.
func (fr *fakeRegistry) entry(id, name, desc string, tier registry.Tier, version string, art []byte, tools ...string) registry.Entry {
	p := "/artifacts/" + id + "-" + version + ".tar.gz"
	fr.put(p, art)
	decls := []registry.ToolDecl{}
	for _, tl := range tools {
		decls = append(decls, registry.ToolDecl{Name: tl, Risk: "safe"})
	}
	return registry.Entry{ID: id, Name: name, Description: desc, Tier: tier, Version: version,
		Artifact:    registry.Artifact{URL: fr.srv.URL + p, SHA256: sha256Hex(art), Runtime: registry.RuntimeGoStatic},
		Permissions: registry.Permissions{Network: false, Paths: []string{}}, Tools: decls}
}

func (fr *fakeRegistry) publish(t *testing.T, s *registrytest.Signer, generatedAt string, entries ...registry.Entry) {
	t.Helper()
	gen, err := time.Parse(time.RFC3339, generatedAt)
	if err != nil {
		t.Fatal(err)
	}
	// Contracts §7.6: validUntil is required and at most 30 days out.
	doc, err := json.Marshal(map[string]any{"version": 1, "generatedAt": generatedAt,
		"validUntil": gen.Add(29 * 24 * time.Hour).Format(time.RFC3339), "entries": entries})
	if err != nil {
		t.Fatal(err)
	}
	fr.put("/registry/index.json", doc)
	fr.put("/registry/index.json.sig", s.Sign(doc))
}

func registryDeps(t *testing.T, fr *fakeRegistry, s *registrytest.Signer) (Deps, string) {
	t.Helper()
	home := t.TempDir()
	k, err := registry.LoadKeyring(s.Keyring())
	if err != nil {
		t.Fatal(err)
	}
	src := &registry.Source{
		IndexURL: fr.srv.URL + "/registry/index.json",
		Client:   fr.srv.Client(),
		Keyring:  func() (*registry.Keyring, error) { return k, nil },
		CacheDir: filepath.Join(home, ".cache", "jarvis", "registry"),
		Now:      func() time.Time { return time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC) },
	}
	return Deps{Registry: &registry.Store{Home: home, Source: src, Client: fr.srv.Client()}}, home
}

func describeTool(t *testing.T, d Deps, name, args string) (mcp.Description, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			return tool.Describe(context.Background(), json.RawMessage(args))
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}, nil
}

// threeServers publishes a small index: weather (community, network,
// writes ~/Documents/Weather), jarvis-clock (official), notes (reviewed).
func threeServers(t *testing.T, fr *fakeRegistry, s *registrytest.Signer) registry.Entry {
	weather := fr.entry("weather", "Weather", "Forecasts from met.no.", registry.TierCommunity, "1.2.0", artifactBytes(t, []byte("w")), "weather.today")
	weather.Permissions = registry.Permissions{Network: true, Paths: []string{"~/Documents/Weather"}}
	clock := fr.entry("jarvis-clock", "Clock", "Current time in any time zone, and desktop timers.", registry.TierOfficial, "0.3.0", artifactBytes(t, []byte("c")), "clock.now", "clock.timer")
	notes := fr.entry("notes", "Notes", "Keep short notes.", registry.TierReviewed, "2.0.0", artifactBytes(t, []byte("n")), "notes.add")
	fr.publish(t, s, "2026-10-09T08:00:00Z", weather, clock, notes)
	return weather
}

func TestRegistrySearch(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, _ := registryDeps(t, fr, s)

	got, err := call(t, d, "registry.search", `{"query":"clock"}`)
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, got)["results"].([]any)
	if len(res) != 1 || res[0].(map[string]any)["id"] != "jarvis-clock" || res[0].(map[string]any)["tier"] != "official" {
		t.Fatalf("clock: %v", res)
	}
	// Words match anywhere (name, description, tool names); all must match.
	got, _ = call(t, d, "registry.search", `{"query":"TIME zone"}`)
	if res := asJSON(t, got)["results"].([]any); len(res) != 1 {
		t.Fatalf("time zone: %v", res)
	}
	got, _ = call(t, d, "registry.search", `{"query":"zzz"}`)
	b, _ := json.Marshal(got)
	if string(b) != `{"results":[]}` {
		t.Fatalf("no match must be an empty list: %s", b)
	}
	for _, bad := range []string{`{}`, `{"query":"   "}`, `{"query":"x","limit":3}`} {
		if _, err := call(t, d, "registry.search", bad); code(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", bad, err)
		}
	}
}

func TestRegistrySearchOfflineAndTampered(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, _ := registryDeps(t, fr, s)
	fr.put("/registry/index.json.sig", registrytest.NewSigner(t).Sign([]byte("x")))
	_, err := call(t, d, "registry.search", `{"query":"clock"}`)
	if code(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("tampered: %v", err)
	}
	fr.srv.Close()
	if _, err := call(t, d, "registry.search", `{"query":"clock"}`); code(err) != mcp.CodeOffline {
		t.Fatalf("offline without a cache: %v", err)
	}
}

func TestRegistryToolsWithoutAStoreFailCleanly(t *testing.T) {
	if _, err := call(t, Deps{}, "registry.search", `{"query":"clock"}`); code(err) != mcp.CodeFailed {
		t.Fatalf("err = %v", err)
	}
}

func TestRegistryInstallAndRemove(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, home := registryDeps(t, fr, s)

	got, err := call(t, d, "registry.install", `{"id":"notes","version":"2.0.0"}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	if string(b) != `{"id":"notes","version":"2.0.0","tier":"reviewed","status":"installed","tools":["notes.add"]}` {
		t.Fatalf("install result %s", b)
	}
	if _, err := os.Stat(filepath.Join(home, ".config/jarvis/mcp.d/notes.json")); err != nil {
		t.Fatal(err)
	}
	got, err = call(t, d, "registry.remove", `{"id":"notes"}`)
	b, _ = json.Marshal(got)
	if err != nil || string(b) != `{"id":"notes","version":"2.0.0"}` {
		t.Fatalf("remove %s %v", b, err)
	}
	if _, err := call(t, d, "registry.remove", `{"id":"notes"}`); code(err) != mcp.CodeNotFound {
		t.Fatalf("second remove: %v", err)
	}
}

func TestRegistryInstallRefusals(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, home := registryDeps(t, fr, s)
	if _, err := call(t, d, "registry.install", `{"id":"notes","version":"9.9.9"}`); code(err) != mcp.CodeNotFound {
		t.Errorf("unknown version: %v", err)
	}
	for _, bad := range []string{`{"id":"../x","version":"1"}`, `{"id":"notes"}`, `{"id":"notes","version":"1/2"}`, `{"id":"jarvis-pkg","version":"1"}`, `{"id":"notes","version":"2.0.0","force":true}`} {
		if _, err := call(t, d, "registry.install", bad); code(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", bad, err)
		}
	}
	// The artifact host serves different bytes than the signed index pins.
	fr.put("/artifacts/notes-2.0.0.tar.gz", artifactBytes(t, []byte("evil")))
	_, err := call(t, d, "registry.install", `{"id":"notes","version":"2.0.0"}`)
	if code(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered artifact: %v", err)
	}
	if m, _ := filepath.Glob(filepath.Join(home, ".config/jarvis/mcp.d/*")); len(m) != 0 {
		t.Fatalf("registered after a checksum failure: %v", m)
	}
}

func TestDescribeRegistryInstall(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, home := registryDeps(t, fr, s)

	desc, err := describeTool(t, d, "registry.install", `{"id":"weather","version":"1.2.0"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := mcp.Description{
		Title:  "Add tool server Weather 1.2.0",
		Detail: "Community: not reviewed by the Rafiq project; every action it takes will ask you first · Tools: weather.today · Can use the internet · Can read your home folder; can change: ~/Documents/Weather",
		Source: mcp.SourceNetwork,
	}
	if !reflect.DeepEqual(desc, want) {
		t.Fatalf("got  %+v\nwant %+v", desc, want)
	}
	desc, _ = describeTool(t, d, "registry.install", `{"id":"jarvis-clock","version":"0.3.0"}`)
	if desc.Detail != "Official: made by the Rafiq project · Tools: clock.now, clock.timer · No internet access · Can read your home folder, cannot change it" {
		t.Fatalf("official detail %q", desc.Detail)
	}
	if _, err := os.Stat(filepath.Join(home, ".cache/jarvis/registry/index.json")); !os.IsNotExist(err) {
		t.Fatal("jarvis.describe must not write the cache")
	}
	if _, err := describeTool(t, d, "registry.install", `{"id":"weather","version":"0.0.1"}`); code(err) != mcp.CodeNotFound {
		t.Fatalf("unknown version: %v", err)
	}
}

func TestDescribeRegistryRemove(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, _ := registryDeps(t, fr, s)
	if _, err := describeTool(t, d, "registry.remove", `{"id":"notes"}`); code(err) != mcp.CodeNotFound {
		t.Fatalf("not installed: %v", err)
	}
	if _, err := call(t, d, "registry.install", `{"id":"notes","version":"2.0.0"}`); err != nil {
		t.Fatal(err)
	}
	desc, err := describeTool(t, d, "registry.remove", `{"id":"notes"}`)
	want := mcp.Description{Title: "Remove tool server notes", Detail: "Version 2.0.0 and its files are deleted; its tools stop working.", Source: mcp.SourceSystem}
	if err != nil || !reflect.DeepEqual(desc, want) {
		t.Fatalf("%+v %v", desc, err)
	}
}

func TestRegistryTextHasNoEmptyStrings(t *testing.T) {
	v := reflect.ValueOf(registryText)
	for i := 0; i < v.NumField(); i++ {
		if v.Field(i).String() == "" {
			t.Errorf("registryText.%s is empty", v.Type().Field(i).Name)
		}
	}
}

func TestRegistryListSplitsInstalledAndAvailable(t *testing.T) {
	fr := newFakeRegistry(t)
	s := registrytest.NewSigner(t)
	threeServers(t, fr, s)
	d, _ := registryDeps(t, fr, s)

	var hidden bool
	for _, tool := range Tools(d) {
		if tool.Name == "registry.list" {
			hidden = tool.Hidden && tool.Risk == mcp.RiskSafe
		}
	}
	if !hidden {
		t.Fatal("registry.list must be a hidden safe tool")
	}
	count := func(m map[string]any, k string) []string {
		var ids []string
		for _, e := range m[k].([]any) {
			ids = append(ids, e.(map[string]any)["id"].(string))
		}
		return ids
	}
	got, err := call(t, d, "registry.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, got)
	if len(count(m, "installed")) != 0 || len(count(m, "available")) == 0 {
		t.Fatalf("before install: %v", m)
	}
	total := len(count(m, "available"))
	if _, err := call(t, d, "registry.install", `{"id":"notes","version":"2.0.0"}`); err != nil {
		t.Fatal(err)
	}
	got, _ = call(t, d, "registry.list", `{}`)
	m = asJSON(t, got)
	inst := count(m, "installed")
	if len(inst) != 1 || inst[0] != "notes" || len(count(m, "available")) != total-1 {
		t.Fatalf("after install: %v", m)
	}
	for _, id := range count(m, "available") {
		if id == "notes" {
			t.Fatal("installed id still listed as available")
		}
	}
	if _, err := call(t, d, "registry.list", `{"x":1}`); code(err) != mcp.CodeInvalid {
		t.Fatalf("extra arg: %v", err)
	}
}
