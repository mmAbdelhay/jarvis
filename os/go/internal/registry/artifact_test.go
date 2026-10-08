package registry

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestPackIsDeterministicAndRoundTrips(t *testing.T) {
	files := []PackFile{
		{Name: "lib/util.js", Mode: 0o600, Data: []byte("module.exports = 1\n")},
		{Name: "server", Mode: 0o700, Data: []byte("#!/bin/true\n")},
		{Name: "LICENSE", Mode: 0o644, Data: []byte("MIT\n")},
	}
	var a, b bytes.Buffer
	if err := Pack(&a, files); err != nil {
		t.Fatal(err)
	}
	if err := Pack(&b, []PackFile{files[2], files[0], files[1]}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Fatal("Pack must not depend on input order or time")
	}
	dir := t.TempDir()
	if err := Unpack(bytes.NewReader(a.Bytes()), dir); err != nil {
		t.Fatal(err)
	}
	for name, mode := range map[string]os.FileMode{"server": 0o755, "LICENSE": 0o644, "lib/util.js": 0o644} {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil || st.Mode().Perm() != mode {
			t.Errorf("%s: %v %v, want mode %v", name, st, err, mode)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "lib/util.js")); string(got) != "module.exports = 1\n" {
		t.Fatalf("content %q", got)
	}
	if err := Pack(&bytes.Buffer{}, []PackFile{{Name: "../x", Data: nil}}); err == nil {
		t.Fatal("Pack must refuse a name that leaves the folder")
	}
}

type rawEntry struct {
	name     string
	typeflag byte
	link     string
	body     string
	size     int64 // -1: len(body)
}

func rawTar(t *testing.T, entries ...rawEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, e := range entries {
		size := e.size
		if size < 0 {
			size = int64(len(e.body))
		}
		h := &tar.Header{Name: e.name, Typeflag: e.typeflag, Linkname: e.link, Mode: 0o755, Size: size}
		if e.typeflag != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size > 0 {
			tw.Write([]byte(e.body))
		}
	}
	tw.Flush() // no Close: some cases are deliberately short
	zw.Close()
	return buf.Bytes()
}

func TestUnpackRefusesHostileArchives(t *testing.T) {
	cases := map[string][]byte{
		"parent escape": rawTar(t, rawEntry{name: "../evil", typeflag: tar.TypeReg, body: "x", size: -1}),
		"nested escape": rawTar(t, rawEntry{name: "a/../../evil", typeflag: tar.TypeReg, body: "x", size: -1}),
		"absolute":      rawTar(t, rawEntry{name: "/tmp/evil", typeflag: tar.TypeReg, body: "x", size: -1}),
		"symlink":       rawTar(t, rawEntry{name: "server", typeflag: tar.TypeSymlink, link: "../../../.ssh/id_rsa"}),
		"hard link":     rawTar(t, rawEntry{name: "server", typeflag: tar.TypeLink, link: "/etc/passwd"}),
		"device":        rawTar(t, rawEntry{name: "server", typeflag: tar.TypeChar}),
		"fifo":          rawTar(t, rawEntry{name: "server", typeflag: tar.TypeFifo}),
		"duplicate":     rawTar(t, rawEntry{name: "server", typeflag: tar.TypeReg, body: "a", size: -1}, rawEntry{name: "./server", typeflag: tar.TypeReg, body: "b", size: -1}),
		"backslash":     rawTar(t, rawEntry{name: `..\evil`, typeflag: tar.TypeReg, body: "x", size: -1}),
		"not gzip":      []byte("PK\x03\x04 this is a zip"),
		"symlink then file": rawTar(t,
			rawEntry{name: "lib", typeflag: tar.TypeSymlink, link: ".."},
			rawEntry{name: "lib/evil", typeflag: tar.TypeReg, body: "x", size: -1}),
	}
	for name, archive := range cases {
		parent := t.TempDir()
		dir := filepath.Join(parent, "x")
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		err := Unpack(bytes.NewReader(archive), dir)
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
		if _, err := os.Lstat(filepath.Join(parent, "evil")); err == nil {
			t.Errorf("%s: wrote outside the folder", name)
		}
	}
}

func TestUnpackLimits(t *testing.T) {
	big := rawTar(t, rawEntry{name: "server", typeflag: tar.TypeReg, body: strings.Repeat("a", 11), size: -1})
	if err := unpack(bytes.NewReader(big), t.TempDir(), limits{bytes: 10, files: 5}); !errors.Is(err, ErrInvalid) {
		t.Errorf("size cap: %v", err)
	}
	many := rawTar(t,
		rawEntry{name: "a", typeflag: tar.TypeReg, body: "1", size: -1},
		rawEntry{name: "b", typeflag: tar.TypeReg, body: "1", size: -1},
		rawEntry{name: "c", typeflag: tar.TypeReg, body: "1", size: -1})
	if err := unpack(bytes.NewReader(many), t.TempDir(), limits{bytes: 100, files: 2}); !errors.Is(err, ErrInvalid) {
		t.Errorf("file cap: %v", err)
	}
	// A header that claims more than the cap is refused before any read.
	liar := rawTar(t, rawEntry{name: "server", typeflag: tar.TypeReg, body: "", size: MaxUnpackedBytes + 1})
	if err := Unpack(bytes.NewReader(liar), t.TempDir()); !errors.Is(err, ErrInvalid) {
		t.Errorf("claimed size: %v", err)
	}
}

func TestDownload(t *testing.T) {
	rs := newRegistryServer(t)
	art := []byte("artifact bytes")
	rs.set("/a.tar.gz", art)
	ctx := context.Background()

	var got bytes.Buffer
	if err := Download(ctx, rs.srv.Client(), rs.url("/a.tar.gz"), sha256Hex(art), &got); err != nil || got.String() != "artifact bytes" {
		t.Fatalf("good download: %q %v", got.String(), err)
	}
	if err := Download(ctx, rs.srv.Client(), rs.url("/a.tar.gz"), sha256Hex([]byte("other")), &bytes.Buffer{}); !errors.Is(err, ErrChecksum) {
		t.Fatalf("mismatch: %v", err)
	}
	if err := Download(ctx, rs.srv.Client(), rs.url("/missing"), sha256Hex(art), &bytes.Buffer{}); !errors.Is(err, ErrNetwork) {
		t.Fatalf("404: %v", err)
	}
	if err := download(ctx, rs.srv.Client(), rs.url("/a.tar.gz"), sha256Hex(art), &bytes.Buffer{}, 4); err == nil || errors.Is(err, ErrChecksum) {
		t.Fatalf("over the cap: %v", err)
	}
	if err := Download(ctx, rs.srv.Client(), strings.Replace(rs.url("/a.tar.gz"), "https", "http", 1), sha256Hex(art), &bytes.Buffer{}); err == nil {
		t.Fatal("plain http must be refused")
	}
}

func TestEntryPoint(t *testing.T) {
	if EntryPoint(RuntimeGoStatic) != "server" || EntryPoint(RuntimeNode) != "server.js" || EntryPoint(RuntimePython) != "server.py" {
		t.Fatal("entry points (contracts §3)")
	}
}
