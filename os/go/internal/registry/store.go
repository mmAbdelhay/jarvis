package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// Interpreters for the non-static runtimes. jarvisd's bundled Node is on
// every Rafiq system and in jarvis-agent (M1 contracts §4).
const (
	NodePath   = "/usr/lib/jarvis/node/bin/node"
	PythonPath = "/usr/bin/python3"
)

var (
	ErrNotInstalled   = errors.New("registry: that tool server is not installed")
	ErrRuntimeMissing = errors.New("registry: the runtime this tool server needs is not installed")
)

// Registration is ~/.config/jarvis/mcp.d/<id>.json (contracts §3).
type Registration struct {
	ID          string      `json:"id"`
	Version     string      `json:"version"`
	Tier        Tier        `json:"tier"`
	Command     []string    `json:"command"`
	Permissions Permissions `json:"permissions"`
	Tools       []ToolDecl  `json:"tools"` // contracts §7.3
}

// InstallStatus says what Install did.
type InstallStatus string

const (
	StatusInstalled InstallStatus = "installed"
	StatusUpgraded  InstallStatus = "upgraded"
	StatusAlready   InstallStatus = "already_installed"
)

// InstallResult is registry.install's structuredContent.
type InstallResult struct {
	ID      string        `json:"id"`
	Version string        `json:"version"`
	Tier    Tier          `json:"tier"`
	Status  InstallStatus `json:"status"`
	Tools   []string      `json:"tools"`
}

// Store installs registry servers for one user.
type Store struct {
	Home   string // absolute $HOME
	Source *Source
	Client *http.Client
	// HasRuntime reports whether an interpreter exists; nil means os.Stat.
	HasRuntime func(path string) bool
}

func (s *Store) mcpRoot() string { return filepath.Join(s.Home, ".local", "share", "jarvis", "mcp") }

// ServerDir is ~/.local/share/jarvis/mcp/<id>/<version>.
func (s *Store) ServerDir(id, version string) string { return filepath.Join(s.mcpRoot(), id, version) }

// ArtifactPath is the verified tarball kept beside the version folder,
// ~/.local/share/jarvis/mcp/<id>/<version>.tar.gz. jarvisd re-hashes it
// against the index sha256 at every launch (contracts §7.2).
func (s *Store) ArtifactPath(id, version string) string {
	return filepath.Join(s.mcpRoot(), id, version+".tar.gz")
}

// RegistrationPath is ~/.config/jarvis/mcp.d/<id>.json.
func (s *Store) RegistrationPath(id string) string {
	return filepath.Join(s.Home, ".config", "jarvis", "mcp.d", id+".json")
}

// Command is the argv jarvisd runs for a server unpacked in dir.
func Command(rt Runtime, dir string) []string {
	ep := filepath.Join(dir, EntryPoint(rt))
	switch rt {
	case RuntimeNode:
		return []string{NodePath, ep}
	case RuntimePython:
		return []string{PythonPath, "-I", ep}
	default:
		return []string{ep}
	}
}

func (s *Store) hasRuntime(p string) bool {
	if s.HasRuntime != nil {
		return s.HasRuntime(p)
	}
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func regularFile(p string) bool {
	st, err := os.Lstat(p)
	return err == nil && st.Mode().IsRegular()
}

// lock serialises installs and removes across processes (flock).
func (s *Store) lock() (func(), error) {
	if err := os.MkdirAll(s.mcpRoot(), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(s.mcpRoot(), ".lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}

// Read returns one registration.
func (s *Store) Read(id string) (Registration, error) {
	if err := ValidID(id); err != nil {
		return Registration{}, err
	}
	b, err := os.ReadFile(s.RegistrationPath(id))
	if errors.Is(err, fs.ErrNotExist) {
		return Registration{}, ErrNotInstalled
	}
	if err != nil {
		return Registration{}, err
	}
	var r Registration
	if err := json.Unmarshal(b, &r); err != nil || r.ID != id {
		return Registration{}, invalid("the registration of %s is damaged", id)
	}
	return r, nil
}

// Installed lists every readable registration, sorted by id.
func (s *Store) Installed() ([]Registration, error) {
	matches, err := filepath.Glob(filepath.Join(s.Home, ".config", "jarvis", "mcp.d", "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(matches)
	out := []Registration{}
	for _, m := range matches {
		r, err := s.Read(strings.TrimSuffix(filepath.Base(m), ".json"))
		if err != nil {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func toolNames(e Entry) []string {
	out := []string{}
	for _, t := range e.Tools {
		out = append(out, t.Name)
	}
	return out
}

// Install puts e in place: download → SHA-256 → unpack into a staging
// folder → entry point check → rename → registration → old versions
// removed. Any failure before the registration leaves the previous
// version registered and untouched.
func (s *Store) Install(ctx context.Context, e Entry) (InstallResult, error) {
	if err := e.Validate(); err != nil {
		return InstallResult{}, err
	}
	final := s.ServerDir(e.ID, e.Version)
	cmd := Command(e.Artifact.Runtime, final)
	if e.Artifact.Runtime != RuntimeGoStatic && !s.hasRuntime(cmd[0]) {
		return InstallResult{}, fmt.Errorf("%w: %s needs %s", ErrRuntimeMissing, e.Name, cmd[0])
	}
	unlock, err := s.lock()
	if err != nil {
		return InstallResult{}, err
	}
	defer unlock()

	res := InstallResult{ID: e.ID, Version: e.Version, Tier: e.Tier, Status: StatusInstalled, Tools: toolNames(e)}
	if prev, err := s.Read(e.ID); err == nil {
		if prev.Version == e.Version && regularFile(cmd[len(cmd)-1]) && regularFile(s.ArtifactPath(e.ID, e.Version)) {
			res.Status = StatusAlready
			return res, nil
		}
		res.Status = StatusUpgraded
	}

	idDir := filepath.Join(s.mcpRoot(), e.ID)
	if err := os.MkdirAll(idDir, 0o700); err != nil {
		return InstallResult{}, err
	}
	staging, err := os.MkdirTemp(idDir, ".staging-")
	if err != nil {
		return InstallResult{}, err
	}
	defer os.RemoveAll(staging) // a no-op once renamed
	dl, err := s.fetchInto(ctx, e, staging)
	if err != nil {
		os.RemoveAll(staging)
		os.Remove(idDir) // only succeeds when nothing else is in it
		return InstallResult{}, err
	}
	defer os.Remove(dl) // a no-op once renamed
	if err := os.Rename(dl, s.ArtifactPath(e.ID, e.Version)); err != nil {
		return InstallResult{}, err
	}
	if err := os.RemoveAll(final); err != nil { // leftover of a broken attempt
		return InstallResult{}, err
	}
	if err := os.Rename(staging, final); err != nil {
		return InstallResult{}, err
	}

	reg := Registration{ID: e.ID, Version: e.Version, Tier: e.Tier, Command: cmd, Permissions: e.Permissions, Tools: e.Tools}
	if reg.Tools == nil {
		reg.Tools = []ToolDecl{}
	}
	if reg.Permissions.Paths == nil {
		reg.Permissions.Paths = []string{}
	}
	b, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(s.RegistrationPath(e.ID)), 0o700); err != nil {
		return InstallResult{}, err
	}
	if err := writeAtomic(s.RegistrationPath(e.ID), append(b, '\n'), 0o600); err != nil {
		return InstallResult{}, err
	}
	// Older versions go only once the new registration is in place.
	des, _ := os.ReadDir(idDir)
	for _, d := range des {
		if d.Name() != e.Version && d.Name() != e.Version+".tar.gz" {
			os.RemoveAll(filepath.Join(idDir, d.Name()))
		}
	}
	return res, nil
}

// fetchInto downloads and verifies the artifact, unpacks it into dir and
// returns the path of the verified tarball (a temp file the caller renames
// into place or removes).
func (s *Store) fetchInto(ctx context.Context, e Entry, dir string) (string, error) {
	tmp, err := os.CreateTemp(filepath.Dir(dir), ".download-")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		tmp.Close()
		if !ok {
			os.Remove(name)
		}
	}()
	if err := Download(ctx, s.Client, e.Artifact.URL, e.Artifact.SHA256, tmp); err != nil {
		return "", err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if err := Unpack(tmp, dir); err != nil {
		return "", err
	}
	ep := EntryPoint(e.Artifact.Runtime)
	if !regularFile(filepath.Join(dir, ep)) {
		return "", invalid("the artifact of %s has no %s", e.ID, ep)
	}
	if e.Artifact.Runtime == RuntimeGoStatic {
		if err := os.Chmod(filepath.Join(dir, ep), 0o755); err != nil {
			return "", err
		}
	}
	if err := os.Chmod(name, 0o600); err != nil {
		return "", err
	}
	ok = true
	return name, nil
}

// Remove deletes the registration first (jarvisd stops the server) and
// then the files. A damaged registration is removed too.
func (s *Store) Remove(ctx context.Context, id string) (Registration, error) {
	if err := ValidID(id); err != nil {
		return Registration{}, err
	}
	unlock, err := s.lock()
	if err != nil {
		return Registration{}, err
	}
	defer unlock()
	reg, rerr := s.Read(id)
	idDir := filepath.Join(s.mcpRoot(), id)
	_, derr := os.Stat(idDir)
	if errors.Is(rerr, ErrNotInstalled) && errors.Is(derr, fs.ErrNotExist) {
		return Registration{}, ErrNotInstalled
	}
	if err := os.Remove(s.RegistrationPath(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return Registration{}, err
	}
	if err := os.RemoveAll(idDir); err != nil {
		return Registration{}, err
	}
	if rerr != nil {
		reg = Registration{ID: id}
	}
	return reg, nil
}
