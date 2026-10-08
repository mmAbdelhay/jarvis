package fileops

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// Kind is one file operation (Rafiq M3 contracts §1).
type Kind string

const (
	Move    Kind = "move"
	Copy    Kind = "copy"
	Rename  Kind = "rename"
	Mkdir   Kind = "mkdir"
	Trash   Kind = "trash"
	Restore Kind = "restore"
)

// Step is one change that happened, with real absolute paths, and the
// fingerprint of what the change left behind so undo can tell whether the
// user has touched it since.
type Step struct {
	Kind      Kind   `json:"kind"`
	From      string `json:"from"`
	To        string `json:"to,omitempty"`
	TrashName string `json:"trashName,omitempty"`
	Dir       bool   `json:"dir,omitempty"`
	Size      int64  `json:"size,omitempty"`
	ModNs     int64  `json:"modNs,omitempty"`
}

// Entry is one journal record: the steps of one tool call.
type Entry struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"` // RFC 3339 UTC with nanoseconds
	Steps     []Step `json:"steps"`
}

// Journal keeps the last Keep entries in Dir (0700) as
// "<20-digit unix nanos>-<id>.json", so name order is age order.
type Journal struct {
	Dir  string // e.g. ~/.local/state/jarvis/files-journal
	Keep int    // 0: 50
}

// StateDir returns $XDG_STATE_HOME/jarvis/files-journal (default
// ~/.local/state/jarvis/files-journal).
func StateDir(getenv func(string) string) string {
	state := getenv("XDG_STATE_HOME")
	if state == "" || !filepath.IsAbs(state) {
		state = filepath.Join(getenv("HOME"), ".local", "state")
	}
	return filepath.Join(state, "jarvis", "files-journal")
}

var idRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// ErrNoJournal: the id is unknown, malformed or already undone.
var ErrNoJournal = errors.New("no such file change to undo")

// ValidID reports whether id has the journal id shape.
func ValidID(id string) bool { return idRe.MatchString(id) }

func (j Journal) keep() int {
	if j.Keep <= 0 {
		return 50
	}
	return j.Keep
}

// Save writes e atomically and drops the oldest entries beyond Keep.
func (j Journal) Save(e Entry) error {
	if !ValidID(e.ID) {
		return fmt.Errorf("journal: bad id %q", e.ID)
	}
	if err := os.MkdirAll(j.Dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(j.Dir, ".tmp-*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return errors.Join(werr, cerr)
	}
	created, err := time.Parse(time.RFC3339Nano, e.CreatedAt)
	if err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("journal: bad createdAt %q", e.CreatedAt)
	}
	name := fmt.Sprintf("%020d-%s.json", created.UnixNano(), e.ID)
	if err := os.Rename(tmp.Name(), filepath.Join(j.Dir, name)); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return j.prune()
}

var fileRe = regexp.MustCompile(`^[0-9]{20}-([0-9a-f]{16})\.json$`)

// files returns the journal's file names, oldest first.
func (j Journal) files() ([]string, error) {
	ents, err := os.ReadDir(j.Dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range ents {
		if fileRe.MatchString(e.Name()) && e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func (j Journal) prune() error {
	names, err := j.files()
	if err != nil {
		return err
	}
	for i := 0; i < len(names)-j.keep(); i++ {
		os.Remove(filepath.Join(j.Dir, names[i]))
	}
	return nil
}

// path finds the file of entry id.
func (j Journal) path(id string) (string, error) {
	if !ValidID(id) {
		return "", ErrNoJournal
	}
	names, err := j.files()
	if err != nil {
		return "", err
	}
	for _, n := range names {
		if fileRe.FindStringSubmatch(n)[1] == id {
			return filepath.Join(j.Dir, n), nil
		}
	}
	return "", ErrNoJournal
}

// Load reads one entry.
func (j Journal) Load(id string) (Entry, error) {
	p, err := j.path(id)
	if err != nil {
		return Entry{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Entry{}, ErrNoJournal
	}
	var e Entry
	if err := json.Unmarshal(b, &e); err != nil || e.ID != id {
		return Entry{}, ErrNoJournal
	}
	return e, nil
}

// Delete forgets one entry.
func (j Journal) Delete(id string) error {
	p, err := j.path(id)
	if errors.Is(err, ErrNoJournal) {
		return nil
	}
	if err != nil {
		return err
	}
	return os.Remove(p)
}
