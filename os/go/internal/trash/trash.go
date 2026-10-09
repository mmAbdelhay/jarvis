// Package trash is the freedesktop.org Trash specification (1.0) for the
// home trash: $XDG_DATA_HOME/Trash (default ~/.local/share/Trash) with
// files/ and info/<name>.trashinfo. jarvis-files never deletes a file; it
// moves it here, where every file manager can show and restore it.
//
// Trashing renames, so it only works on the home trash's filesystem; a file
// on another drive is refused with ErrOtherDevice (a "top directory" trash
// on removable drives is not used: jarvis-files only works inside $HOME).
package trash

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var (
	// ErrOtherDevice: the file is on another filesystem than the trash.
	ErrOtherDevice = errors.New("the file is on another drive than the trash")
	// ErrExists: the restore destination is already taken.
	ErrExists = errors.New("something already exists at that place")
	// ErrNotFound: no such item in the trash.
	ErrNotFound = errors.New("not in the trash")
)

// dateLayout is the spec's DeletionDate: local time, no zone.
const dateLayout = "2006-01-02T15:04:05"

// Item is one trashed file or folder.
type Item struct {
	Name         string    // name inside files/ (and info/<Name>.trashinfo)
	OriginalPath string    // absolute path it was trashed from
	DeletionDate time.Time // local time as written in the info file
}

// Trash is one home trash folder.
type Trash struct {
	Dir string           // absolute, e.g. /home/u/.local/share/Trash
	Now func() time.Time // nil: time.Now
}

// Home returns the home trash for $XDG_DATA_HOME / $HOME.
func Home(getenv func(string) string) Trash {
	data := getenv("XDG_DATA_HOME")
	if data == "" || !filepath.IsAbs(data) {
		data = filepath.Join(getenv("HOME"), ".local", "share")
	}
	return Trash{Dir: filepath.Join(data, "Trash")}
}

func (t Trash) now() time.Time {
	if t.Now == nil {
		return time.Now()
	}
	return t.Now()
}

func (t Trash) files() string { return filepath.Join(t.Dir, "files") }
func (t Trash) info() string  { return filepath.Join(t.Dir, "info") }

// escapePath URL-escapes each segment of an absolute path (spec: "Path"
// is escaped like a URI path), keeping the slashes.
func escapePath(abs string) string {
	parts := strings.Split(abs, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// candidate returns the n-th name to try for base: "a.txt", "a.2.txt", ...
func candidate(base string, n int) string {
	if n == 1 {
		return base
	}
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" {
		stem, ext = base, ""
	}
	return stem + "." + strconv.Itoa(n) + ext
}

// Put moves abs (a file, folder or link; never followed) into the trash.
// The info file is claimed first with O_EXCL, as the spec asks, so two
// trashings of same-named files never collide.
func (t Trash) Put(abs string) (Item, error) {
	if !filepath.IsAbs(abs) {
		return Item{}, fmt.Errorf("trash: %q is not absolute", abs)
	}
	if _, err := os.Lstat(abs); err != nil {
		return Item{}, err
	}
	for _, d := range []string{t.files(), t.info()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return Item{}, err
		}
	}
	when := t.now()
	base := filepath.Base(abs)
	for n := 1; n <= 1000; n++ {
		name := candidate(base, n)
		infoPath := filepath.Join(t.info(), name+".trashinfo")
		f, err := os.OpenFile(infoPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return Item{}, err
		}
		if _, err := os.Lstat(filepath.Join(t.files(), name)); err == nil {
			// A stray file without info: leave it alone, try the next name.
			f.Close()
			os.Remove(infoPath)
			continue
		}
		body := "[Trash Info]\nPath=" + escapePath(abs) + "\nDeletionDate=" + when.Format(dateLayout) + "\n"
		_, werr := f.WriteString(body)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			os.Remove(infoPath)
			return Item{}, errors.Join(werr, cerr)
		}
		if err := os.Rename(abs, filepath.Join(t.files(), name)); err != nil {
			os.Remove(infoPath)
			if errors.Is(err, syscall.EXDEV) {
				return Item{}, ErrOtherDevice
			}
			return Item{}, err
		}
		return Item{Name: name, OriginalPath: abs, DeletionDate: parseDate(when.Format(dateLayout))}, nil
	}
	return Item{}, fmt.Errorf("trash: no free name for %s", base)
}

func parseDate(s string) time.Time {
	t, err := time.ParseInLocation(dateLayout, s, time.Local)
	if err != nil {
		return time.Time{}
	}
	return t
}

// parseInfo reads one .trashinfo file.
func parseInfo(data []byte) (path string, date time.Time, ok bool) {
	sc := bufio.NewScanner(bytes.NewReader(data))
	inGroup := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			inGroup = line == "[Trash Info]"
			continue
		}
		if !inGroup {
			continue
		}
		k, v, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		switch k {
		case "Path":
			p, err := url.PathUnescape(v)
			if err != nil || !filepath.IsAbs(p) {
				return "", time.Time{}, false
			}
			path = filepath.Clean(p)
		case "DeletionDate":
			date = parseDate(v)
		}
	}
	return path, date, path != ""
}

func validName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsRune(name, '/') && !strings.ContainsRune(name, 0)
}

// Get returns one item by name.
func (t Trash) Get(name string) (Item, error) {
	if !validName(name) {
		return Item{}, ErrNotFound
	}
	data, err := os.ReadFile(filepath.Join(t.info(), name+".trashinfo"))
	if err != nil {
		return Item{}, ErrNotFound
	}
	p, d, ok := parseInfo(data)
	if !ok {
		return Item{}, ErrNotFound
	}
	if _, err := os.Lstat(filepath.Join(t.files(), name)); err != nil {
		return Item{}, ErrNotFound
	}
	return Item{Name: name, OriginalPath: p, DeletionDate: d}, nil
}

// List returns every valid item, newest first. Broken entries are skipped.
func (t Trash) List() ([]Item, error) {
	ents, err := os.ReadDir(t.info())
	if errors.Is(err, fs.ErrNotExist) {
		return []Item{}, nil
	}
	if err != nil {
		return nil, err
	}
	items := []Item{}
	for _, e := range ents {
		name, ok := strings.CutSuffix(e.Name(), ".trashinfo")
		if !ok || !e.Type().IsRegular() {
			continue
		}
		if it, err := t.Get(name); err == nil {
			items = append(items, it)
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].DeletionDate.Equal(items[j].DeletionDate) {
			return items[i].DeletionDate.After(items[j].DeletionDate)
		}
		return items[i].Name > items[j].Name
	})
	return items, nil
}

// Find returns the newest item that was trashed from original.
func (t Trash) Find(original string) (Item, error) {
	items, err := t.List()
	if err != nil {
		return Item{}, err
	}
	original = filepath.Clean(original)
	for _, it := range items {
		if it.OriginalPath == original {
			return it, nil
		}
	}
	return Item{}, ErrNotFound
}

// Restore moves item name back to dest (absolute; normally its
// OriginalPath), creating missing parent folders. It never overwrites.
func (t Trash) Restore(name, dest string) error {
	if _, err := t.Get(name); err != nil {
		return err
	}
	if !filepath.IsAbs(dest) {
		return fmt.Errorf("trash: %q is not absolute", dest)
	}
	if _, err := os.Lstat(dest); err == nil {
		return ErrExists
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(t.files(), name), dest); err != nil {
		if errors.Is(err, syscall.EXDEV) {
			return ErrOtherDevice
		}
		return err
	}
	return os.Remove(filepath.Join(t.info(), name+".trashinfo"))
}
