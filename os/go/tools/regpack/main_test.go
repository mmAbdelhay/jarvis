package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
)

func fakeBins(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, id := range []string{"jarvis-clock", "jarvis-files", "jarvis-web"} {
		if err := os.MkdirAll(filepath.Join(dir, id), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, id, "server"), []byte("binary of "+id), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestBuildWritesDeterministicArtifactsAndEntries(t *testing.T) {
	bins := fakeBins(t)
	o := options{bin: bins, version: "0.3.0", baseURL: "https://example.org/registry/artifacts/", license: []byte("MIT\n")}
	o.out = t.TempDir()
	entries, err := build(o)
	if err != nil {
		t.Fatal(err)
	}
	o2 := o
	o2.out = t.TempDir()
	if _, err := build(o2); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, e := range entries {
		ids = append(ids, e.ID)
		name := e.ID + "/0.3.0/" + e.ID + "-0.3.0-linux-amd64.tar.gz"
		a, _ := os.ReadFile(filepath.Join(o.out, "artifacts", name))
		b, _ := os.ReadFile(filepath.Join(o2.out, "artifacts", name))
		if len(a) == 0 || !bytes.Equal(a, b) {
			t.Errorf("%s: artifacts differ between runs", e.ID)
		}
		sum := sha256.Sum256(a)
		if e.Artifact.SHA256 != hex.EncodeToString(sum[:]) || e.Artifact.URL != "https://example.org/registry/artifacts/"+name {
			t.Errorf("%s: artifact %+v", e.ID, e.Artifact)
		}
		dir := t.TempDir()
		if err := registry.Unpack(bytes.NewReader(a), dir); err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(filepath.Join(dir, "server")); string(got) != "binary of "+e.ID {
			t.Errorf("%s: packed server %q", e.ID, got)
		}
		if err := e.Validate(); err != nil {
			t.Error(err)
		}
	}
	if !reflect.DeepEqual(ids, []string{"jarvis-clock", "jarvis-files", "jarvis-web"}) {
		t.Fatalf("ids %v", ids)
	}
	raw, _ := os.ReadFile(filepath.Join(o.out, "entries.json"))
	var back []registry.Entry
	if err := json.Unmarshal(raw, &back); err != nil || !reflect.DeepEqual(back, entries) {
		t.Fatalf("entries.json does not round-trip: %v", err)
	}
}

// TestOfficialServersMatchContract pins contracts §3: the three official
// servers, their tool names, all safe, official tier, go-static.
func TestOfficialServersMatchContract(t *testing.T) {
	entries, err := build(options{bin: fakeBins(t), out: t.TempDir(), version: "0.3.0", baseURL: "https://example.org/a"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]registry.ToolDecl{
		"jarvis-clock": {{Name: "clock.now", Risk: "safe"}, {Name: "clock.timer", Risk: "safe"}},
		"jarvis-files": {{Name: "files.search", Risk: "safe"}, {Name: "files.preview", Risk: "safe"}},
		"jarvis-web":   {{Name: "web.fetch", Risk: "safe"}},
	}
	network := map[string]bool{"jarvis-clock": false, "jarvis-files": false, "jarvis-web": true}
	for _, e := range entries {
		if !reflect.DeepEqual(e.Tools, want[e.ID]) {
			t.Errorf("%s tools %+v", e.ID, e.Tools)
		}
		if e.Tier != registry.TierOfficial || e.Artifact.Runtime != registry.RuntimeGoStatic || e.Permissions.Network != network[e.ID] || len(e.Permissions.Paths) != 0 {
			t.Errorf("%s: %+v", e.ID, e)
		}
	}
	if len(entries) != len(want) {
		t.Fatalf("%d entries", len(entries))
	}
}

func TestBuildRefusals(t *testing.T) {
	if _, err := build(options{bin: t.TempDir(), out: t.TempDir(), version: "0.3.0", baseURL: "https://example.org"}); err == nil || !strings.Contains(err.Error(), "make registry") {
		t.Errorf("missing binaries: %v", err)
	}
	if _, err := build(options{bin: fakeBins(t), out: t.TempDir(), version: "../0.3", baseURL: "https://example.org"}); err == nil {
		t.Error("bad version accepted")
	}
	if _, err := build(options{bin: fakeBins(t), out: t.TempDir(), version: "0.3.0", baseURL: "http://example.org"}); err == nil {
		t.Error("http base URL accepted")
	}
}
