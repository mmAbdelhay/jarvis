package registry

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"
)

func packServer(t *testing.T, rt Runtime, files ...PackFile) []byte {
	t.Helper()
	if files == nil {
		files = []PackFile{
			{Name: EntryPoint(rt), Mode: 0o755, Data: []byte("server body\n")},
			{Name: "LICENSE", Mode: 0o644, Data: []byte("MIT\n")},
		}
	}
	var b bytes.Buffer
	if err := Pack(&b, files); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// serve publishes art at a fresh path and returns a reviewed entry for it.
func serve(rs *registryServer, id, version string, rt Runtime, art []byte) Entry {
	p := fmt.Sprintf("/artifacts/%s-%s.tar.gz", id, version)
	rs.set(p, art)
	e := validEntry()
	e.ID, e.Version, e.Tier = id, version, TierReviewed
	e.Artifact = Artifact{URL: rs.url(p), SHA256: sha256Hex(art), Runtime: rt}
	e.Permissions = Permissions{Network: false, Paths: []string{"~/Documents"}}
	return e
}

func newStore(t *testing.T, rs *registryServer) *Store {
	return &Store{Home: t.TempDir(), Client: rs.srv.Client(), HasRuntime: func(string) bool { return true }}
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, d := range des {
		out = append(out, d.Name())
	}
	sort.Strings(out)
	return out
}

func TestInstallFreshWritesServerAndRegistration(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	e := serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))

	res, err := st.Install(context.Background(), e)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res, InstallResult{ID: "weather", Version: "1.2.0", Tier: TierReviewed, Status: StatusInstalled, Tools: []string{"weather.today"}}) {
		t.Fatalf("result %+v", res)
	}
	server := filepath.Join(st.Home, ".local/share/jarvis/mcp/weather/1.2.0/server")
	if fi, err := os.Stat(server); err != nil || fi.Mode().Perm() != 0o755 {
		t.Fatalf("server: %v %v", fi, err)
	}
	reg := filepath.Join(st.Home, ".config/jarvis/mcp.d/weather.json")
	if reg != st.RegistrationPath("weather") {
		t.Fatalf("RegistrationPath = %s", st.RegistrationPath("weather"))
	}
	b, err := os.ReadFile(reg)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{
  "id": "weather",
  "version": "1.2.0",
  "tier": "reviewed",
  "command": [
    %q
  ],
  "permissions": {
    "network": false,
    "paths": [
      "~/Documents"
    ]
  },
  "tools": [
    {
      "name": "weather.today",
      "risk": "safe"
    }
  ]
}
`, server)
	if string(b) != want {
		t.Fatalf("registration\n got %s\nwant %s", b, want)
	}
	if fi, _ := os.Stat(reg); fi.Mode().Perm() != 0o600 {
		t.Fatalf("registration mode %v", fi.Mode())
	}
	if got := names(t, filepath.Join(st.Home, ".local/share/jarvis/mcp")); !reflect.DeepEqual(got, []string{".lock", "weather"}) {
		t.Fatalf("mcp root holds %v", got)
	}
	if got := names(t, filepath.Join(st.Home, ".local/share/jarvis/mcp/weather")); !reflect.DeepEqual(got, []string{"1.2.0"}) {
		t.Fatalf("leftovers next to the version: %v", got)
	}
}

func TestInstallSameVersionIsANoOp(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	e := serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))
	if _, err := st.Install(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	res, err := st.Install(context.Background(), e)
	if err != nil || res.Status != StatusAlready {
		t.Fatalf("%+v %v", res, err)
	}
	if n := rs.hits("/artifacts/weather-1.2.0.tar.gz"); n != 1 {
		t.Fatalf("downloaded %d times", n)
	}
}

func TestUpgradeSwitchesAndDropsTheOldVersion(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	if _, err := st.Install(context.Background(), serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))); err != nil {
		t.Fatal(err)
	}
	res, err := st.Install(context.Background(), serve(rs, "weather", "1.3.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic)))
	if err != nil || res.Status != StatusUpgraded {
		t.Fatalf("%+v %v", res, err)
	}
	r, err := st.Read("weather")
	if err != nil || r.Version != "1.3.0" {
		t.Fatalf("registration %+v %v", r, err)
	}
	if got := names(t, filepath.Join(st.Home, ".local/share/jarvis/mcp/weather")); !reflect.DeepEqual(got, []string{"1.3.0"}) {
		t.Fatalf("versions left: %v", got)
	}
}

func TestTamperedArtifactLeavesNothing(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	e := serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))
	rs.set("/artifacts/weather-1.2.0.tar.gz", packServer(t, RuntimeGoStatic, PackFile{Name: "server", Mode: 0o755, Data: []byte("evil")}))
	if _, err := st.Install(context.Background(), e); !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(st.RegistrationPath("weather")); !os.IsNotExist(err) {
		t.Fatal("no registration may exist after a checksum failure")
	}
	if got := names(t, filepath.Join(st.Home, ".local/share/jarvis/mcp")); !reflect.DeepEqual(got, []string{".lock"}) {
		t.Fatalf("leftovers: %v", got)
	}
}

func TestFailedUpgradeKeepsWorkingVersion(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	if _, err := st.Install(context.Background(), serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))); err != nil {
		t.Fatal(err)
	}
	// Signed and hashed correctly, but not an archive at all.
	if _, err := st.Install(context.Background(), serve(rs, "weather", "1.3.0", RuntimeGoStatic, []byte("not gzip"))); !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
	r, err := st.Read("weather")
	if err != nil || r.Version != "1.2.0" {
		t.Fatalf("registration %+v %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(st.ServerDir("weather", "1.2.0"), "server")); err != nil {
		t.Fatalf("the working version must survive: %v", err)
	}
	if got := names(t, filepath.Join(st.Home, ".local/share/jarvis/mcp/weather")); !reflect.DeepEqual(got, []string{"1.2.0"}) {
		t.Fatalf("leftovers: %v", got)
	}
}

func TestMissingEntryPointIsRefused(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	art := packServer(t, RuntimeNode, PackFile{Name: "index.js", Mode: 0o644, Data: []byte("x")})
	if _, err := st.Install(context.Background(), serve(rs, "weather", "1.2.0", RuntimeNode, art)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(st.RegistrationPath("weather")); !os.IsNotExist(err) {
		t.Fatal("registered a server without its entry point")
	}
}

func TestMissingRuntimeRefusedBeforeDownload(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	st.HasRuntime = func(p string) bool { return p != PythonPath }
	e := serve(rs, "weather", "1.2.0", RuntimePython, packServer(t, RuntimePython))
	if _, err := st.Install(context.Background(), e); !errors.Is(err, ErrRuntimeMissing) {
		t.Fatalf("err = %v", err)
	}
	if n := rs.hits("/artifacts/weather-1.2.0.tar.gz"); n != 0 {
		t.Fatalf("downloaded %d times before checking the runtime", n)
	}
}

func TestCommands(t *testing.T) {
	if got := Command(RuntimeGoStatic, "/d"); !reflect.DeepEqual(got, []string{"/d/server"}) {
		t.Errorf("go-static %v", got)
	}
	if got := Command(RuntimeNode, "/d"); !reflect.DeepEqual(got, []string{NodePath, "/d/server.js"}) {
		t.Errorf("node %v", got)
	}
	if got := Command(RuntimePython, "/d"); !reflect.DeepEqual(got, []string{PythonPath, "-I", "/d/server.py"}) {
		t.Errorf("python %v", got)
	}
}

func TestConcurrentInstallsDownloadOnce(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	e := serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = st.Install(context.Background(), e)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("install %d: %v", i, err)
		}
	}
	if n := rs.hits("/artifacts/weather-1.2.0.tar.gz"); n != 1 {
		t.Fatalf("downloaded %d times", n)
	}
}

func TestRemove(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	if _, err := st.Install(context.Background(), serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))); err != nil {
		t.Fatal(err)
	}
	r, err := st.Remove(context.Background(), "weather")
	if err != nil || r.ID != "weather" || r.Version != "1.2.0" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := os.Stat(st.RegistrationPath("weather")); !os.IsNotExist(err) {
		t.Fatal("registration left behind")
	}
	if _, err := os.Stat(filepath.Join(st.Home, ".local/share/jarvis/mcp/weather")); !os.IsNotExist(err) {
		t.Fatal("files left behind")
	}
	if _, err := st.Remove(context.Background(), "weather"); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("second remove: %v", err)
	}
	for _, id := range []string{"../x", "jarvis-pkg", ""} {
		if _, err := st.Remove(context.Background(), id); !errors.Is(err, ErrInvalid) {
			t.Errorf("remove %q: %v", id, err)
		}
	}
}

func TestInstalledSkipsDamagedRegistrations(t *testing.T) {
	rs := newRegistryServer(t)
	st := newStore(t, rs)
	if _, err := st.Install(context.Background(), serve(rs, "weather", "1.2.0", RuntimeGoStatic, packServer(t, RuntimeGoStatic))); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(st.Home, ".config/jarvis/mcp.d/broken.json"), []byte("{"), 0o600)
	os.WriteFile(filepath.Join(st.Home, ".config/jarvis/mcp.d/other.json"), []byte(`{"id":"someone-else"}`), 0o600)
	got, err := st.Installed()
	if err != nil || len(got) != 1 || got[0].ID != "weather" {
		t.Fatalf("%+v %v", got, err)
	}
}
