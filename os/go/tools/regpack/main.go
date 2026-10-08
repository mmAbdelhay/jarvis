// regpack packs the official registry servers that `make registry` built
// into deterministic artifacts and writes their registry entries (Rafiq
// M2.5 contracts §3: Plan J builds them, Plan L publishes and signs the
// index). Entries come from each server's own tool list, so the index
// cannot drift from the code.
//
//	go run ./tools/regpack -bin dist-registry -out dist-registry \
//	    -version 0.3.0 -base-url https://…/registry/artifacts [-license ../../LICENSE]
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/mmAbdelhay/jarvis/os/go/internal/clocktools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/filestools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/official"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
	"github.com/mmAbdelhay/jarvis/os/go/internal/webtools"
)

type server struct {
	m     official.Manifest
	tools []mcp.Tool
}

// servers is every official registry server, in id order.
func servers() []server {
	return []server{
		{clocktools.Manifest, clocktools.Tools(clocktools.Deps{})},
		{filestools.Manifest, filestools.Tools(filestools.Deps{})},
		{webtools.Manifest, webtools.Tools(webtools.Deps{})},
	}
}

type options struct {
	bin, out, version, baseURL string
	license                    []byte
}

func build(o options) ([]registry.Entry, error) {
	if err := registry.ValidVersion(o.version); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(o.baseURL, "https://") {
		return nil, fmt.Errorf("base URL %q must be https", o.baseURL)
	}
	base := strings.TrimSuffix(o.baseURL, "/")
	if err := os.MkdirAll(filepath.Join(o.out, "artifacts"), 0o755); err != nil {
		return nil, err
	}
	entries := []registry.Entry{}
	for _, s := range servers() {
		bin, err := os.ReadFile(filepath.Join(o.bin, s.m.ID, "server"))
		if err != nil {
			return nil, fmt.Errorf("%s: %w (run make registry)", s.m.ID, err)
		}
		files := []registry.PackFile{{Name: "server", Mode: 0o755, Data: bin}}
		if len(o.license) > 0 {
			files = append(files, registry.PackFile{Name: "LICENSE", Mode: 0o644, Data: o.license})
		}
		var buf bytes.Buffer
		if err := registry.Pack(&buf, files); err != nil {
			return nil, err
		}
		name := fmt.Sprintf("%s/%s/%s-%s-linux-amd64.tar.gz", s.m.ID, o.version, s.m.ID, o.version)
		if err := os.MkdirAll(filepath.Dir(filepath.Join(o.out, "artifacts", name)), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(o.out, "artifacts", name), buf.Bytes(), 0o644); err != nil {
			return nil, err
		}
		sum := sha256.Sum256(buf.Bytes())
		e := official.Entry(s.m, o.version, s.tools)
		e.Artifact.URL = base + "/" + name
		e.Artifact.SHA256 = hex.EncodeToString(sum[:])
		if err := e.Validate(); err != nil {
			return nil, fmt.Errorf("%s: %w", s.m.ID, err)
		}
		entries = append(entries, e)
	}
	b, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return nil, err
	}
	return entries, os.WriteFile(filepath.Join(o.out, "entries.json"), append(b, '\n'), 0o644)
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("regpack: ")
	var o options
	var license string
	flag.StringVar(&o.bin, "bin", "dist-registry", "folder holding <id>/server binaries")
	flag.StringVar(&o.out, "out", "dist-registry", "output folder")
	flag.StringVar(&o.version, "version", "", "registry version of the servers")
	flag.StringVar(&o.baseURL, "base-url", "https://mmabdelhay.github.io/jarvis-apt/registry/artifacts", "where Plan L publishes the artifacts")
	flag.StringVar(&license, "license", "", "license file to ship in every artifact")
	flag.Parse()
	if license != "" {
		b, err := os.ReadFile(license)
		if err != nil {
			log.Fatal(err)
		}
		o.license = b
	}
	entries, err := build(o)
	if err != nil {
		log.Fatal(err)
	}
	for _, e := range entries {
		fmt.Printf("%s %s %s\n", e.Artifact.SHA256, e.ID, e.Artifact.URL)
	}
}
