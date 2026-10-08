package registry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/registry/registrytest"
)

// registryServer is a TLS file server standing in for the GitHub Pages
// registry and artifact host. Unknown paths are 404.
type registryServer struct {
	srv   *httptest.Server
	mu    sync.Mutex
	files map[string][]byte
	count map[string]int
}

func newRegistryServer(t *testing.T) *registryServer {
	t.Helper()
	rs := &registryServer{files: map[string][]byte{}, count: map[string]int{}}
	rs.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		b, ok := rs.files[r.URL.Path]
		rs.count[r.URL.Path]++
		rs.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(rs.srv.Close)
	return rs
}

func (rs *registryServer) set(path string, b []byte) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.files[path] = b
}

func (rs *registryServer) hits(path string) int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.count[path]
}

func (rs *registryServer) url(path string) string { return rs.srv.URL + path }

const indexPath = "/registry/index.json"

func indexDoc(t *testing.T, generatedAt string, entries ...Entry) []byte {
	t.Helper()
	if entries == nil {
		entries = []Entry{}
	}
	gen, err := time.Parse(time.RFC3339, generatedAt)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(map[string]any{"version": 1, "generatedAt": generatedAt,
		"validUntil": gen.Add(29 * 24 * time.Hour).Format(time.RFC3339), "entries": entries})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// publish serves doc and its signature by s.
func (rs *registryServer) publish(s *registrytest.Signer, doc []byte) {
	rs.set(indexPath, doc)
	rs.set(indexPath+".sig", s.Sign(doc))
}

func newSource(t *testing.T, rs *registryServer, s *registrytest.Signer, cacheDir string) *Source {
	t.Helper()
	k, err := LoadKeyring(s.Keyring())
	if err != nil {
		t.Fatal(err)
	}
	return &Source{
		IndexURL: rs.url(indexPath),
		Client:   rs.srv.Client(),
		Keyring:  func() (*Keyring, error) { return k, nil },
		CacheDir: cacheDir,
		Now:      func() time.Time { return time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC) },
	}
}
