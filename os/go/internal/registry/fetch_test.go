package registry

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/registry/registrytest"
)

func entryNamed(id string) Entry {
	e := validEntry()
	e.ID = id
	return e
}

func TestLoadVerifiesAndCaches(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z", entryNamed("weather")))
	src := newSource(t, rs, s, cache)

	ix, err := src.Load(context.Background(), true)
	if err != nil || len(ix.Entries) != 1 {
		t.Fatalf("load: %v %v", ix, err)
	}
	for _, name := range []string{"index.verified.json", "index.verified.json.sig"} {
		st, err := os.Stat(filepath.Join(cache, name))
		if err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", name, st, err)
		}
	}
	if st, _ := os.Stat(cache); st.Mode().Perm() != 0o700 {
		t.Fatalf("cache dir mode %v", st.Mode())
	}
	c, err := src.Cached()
	if err != nil || c.GeneratedAt != "2026-10-09T08:00:00Z" {
		t.Fatalf("cached: %v %v", c, err)
	}
}

func TestLoadWithoutPersistWritesNothing(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z"))
	if _, err := newSource(t, rs, s, cache).Load(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("persist=false must not create the cache: %v", err)
	}
}

func TestLoadRefusesTamperedIndexEvenWithCache(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	src := newSource(t, rs, s, cache)
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z", entryNamed("weather")))
	if _, err := src.Load(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	good, _ := os.ReadFile(filepath.Join(cache, "index.verified.json"))

	doc := indexDoc(t, "2026-10-10T08:00:00Z", entryNamed("weather"))
	rs.publish(s, doc)
	rs.set(indexPath, bytes.Replace(doc, []byte(`"network":true`), []byte(`"network":false`), 1))
	if _, err := src.Load(context.Background(), true); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("tampered index: err = %v", err)
	}
	if now, _ := os.ReadFile(filepath.Join(cache, "index.verified.json")); !bytes.Equal(now, good) {
		t.Fatal("a tampered index must never reach the cache")
	}
}

func TestLoadRefusesAForeignKey(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	mallory := registrytest.NewSigner(t)
	rs.publish(mallory, indexDoc(t, "2026-10-09T08:00:00Z"))
	if _, err := newSource(t, rs, s, t.TempDir()).Load(context.Background(), true); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadWithoutSignatureIsNeverAccepted(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	rs.set(indexPath, indexDoc(t, "2026-10-09T08:00:00Z")) // no .sig
	_, err := newSource(t, rs, s, t.TempDir()).Load(context.Background(), true)
	if !errors.Is(err, ErrOffline) {
		t.Fatalf("no signature and no cache: err = %v, want ErrOffline", err)
	}
}

func TestLoadOfflineUsesVerifiedCacheOnly(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	src := newSource(t, rs, s, cache)
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z", entryNamed("weather")))
	if _, err := src.Load(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	rs.srv.Close() // offline from here on

	ix, err := src.Load(context.Background(), true)
	if err != nil || len(ix.Entries) != 1 {
		t.Fatalf("offline with cache: %v %v", ix, err)
	}
	// Someone edits the cached copy on disk: it no longer verifies.
	p := filepath.Join(cache, "index.verified.json")
	b, _ := os.ReadFile(p)
	os.WriteFile(p, bytes.Replace(b, []byte("weather"), []byte("weathex"), 1), 0o600)
	if _, err := src.Load(context.Background(), true); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline with an edited cache: err = %v, want ErrOffline", err)
	}
	if _, err := src.Cached(); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("Cached() of an edited cache: %v", err)
	}
}

func TestLoadNeverRollsBack(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	src := newSource(t, rs, s, cache)
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z", entryNamed("weather")))
	if _, err := src.Load(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	newer, _ := os.ReadFile(filepath.Join(cache, "index.verified.json"))

	// A validly signed but older index (e.g. one that still lists a
	// withdrawn server) is replayed.
	rs.publish(s, indexDoc(t, "2026-10-01T08:00:00Z", entryNamed("withdrawn")))
	ix, err := src.Load(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if ix.GeneratedAt != "2026-10-09T08:00:00Z" || ix.Entries[0].ID != "weather" {
		t.Fatalf("rolled back to %s %v", ix.GeneratedAt, ix.Entries)
	}
	if now, _ := os.ReadFile(filepath.Join(cache, "index.verified.json")); !bytes.Equal(now, newer) {
		t.Fatal("the cache must keep the newer index")
	}
}

func TestLoadRefusesPlainHTTPAndOversize(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	src := newSource(t, rs, s, t.TempDir())
	src.IndexURL = strings.Replace(src.IndexURL, "https://", "http://", 1)
	if _, err := src.Load(context.Background(), true); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("http index: %v", err)
	}
	rs.set(indexPath, bytes.Repeat([]byte(" "), MaxIndexBytes+1))
	rs.set(indexPath+".sig", []byte("x"))
	if _, err := newSource(t, rs, s, t.TempDir()).Load(context.Background(), true); err == nil || errors.Is(err, ErrOffline) {
		t.Fatalf("oversize index must be an error of its own: %v", err)
	}
}

func TestLoadWithoutKeyringFails(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z"))
	src := newSource(t, rs, s, t.TempDir())
	src.Keyring = func() (*Keyring, error) { return ReadKeyring(filepath.Join(t.TempDir(), "missing.gpg")) }
	if _, err := src.Load(context.Background(), true); err == nil || !strings.Contains(err.Error(), "jarvis-archive-keyring") {
		t.Fatalf("err = %v", err)
	}
}

func TestWriteAtomicLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.json")
	for _, s := range []string{"one", "two"} {
		if err := writeAtomic(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("leftovers: %v", entries)
	}
	if b, _ := os.ReadFile(p); string(b) != "two" {
		t.Fatalf("content %q", b)
	}
}

func TestLoadRefusesExpiredIndex(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	rs.publish(s, indexDoc(t, "2026-10-09T08:00:00Z", entryNamed("weather")))
	src := newSource(t, rs, s, cache)
	if _, err := src.Load(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	src.Now = func() time.Time { return time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC) }
	if _, err := src.Load(context.Background(), true); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired fetched index: %v", err)
	}
	rs.srv.Close()
	if _, err := src.Load(context.Background(), true); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline with an expired cache: %v", err)
	}
	if _, err := src.Cached(); !errors.Is(err, ErrExpired) {
		t.Fatalf("Cached() of an expired cache: %v", err)
	}
}

func TestLoadNoRollbackAfterCacheExpires(t *testing.T) {
	rs := newRegistryServer(t)
	s := registrytest.NewSigner(t)
	cache := filepath.Join(t.TempDir(), "cache")
	doc := func(gen, until string) []byte {
		return []byte(`{"version":1,"generatedAt":"` + gen + `","validUntil":"` + until + `","entries":[]}`)
	}
	src := newSource(t, rs, s, cache)
	rs.publish(s, doc("2026-10-09T08:00:00Z", "2026-10-10T08:00:00Z"))
	if _, err := src.Load(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	newer, _ := os.ReadFile(filepath.Join(cache, "index.verified.json"))

	src.Now = func() time.Time { return time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC) }
	rs.publish(s, doc("2026-10-01T08:00:00Z", "2026-10-25T08:00:00Z"))
	if _, err := src.Load(context.Background(), true); !errors.Is(err, ErrRollback) {
		t.Fatalf("replayed older index after cache expiry: %v", err)
	}
	if now, _ := os.ReadFile(filepath.Join(cache, "index.verified.json")); !bytes.Equal(now, newer) {
		t.Fatal("the cache must keep the newer index")
	}
}
