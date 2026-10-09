package recipes

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"syscall"
)

// ErrNotFound: there is no recipe file with that id.
var ErrNotFound = errors.New("no such recipe")

// Problem is a recipe file that was skipped, and why.
type Problem struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
}

// Store reads recipes from Dir in FS.
type Store struct {
	FS  fs.FS
	Dir string
	// Trusted vets the directory and every file; nil means RootOwned.
	// Only tests and tools/recipecheck pass another function.
	Trusted func(fs.FileInfo) error
}

func (s *Store) trusted(fi fs.FileInfo) error {
	if s.Trusted != nil {
		return s.Trusted(fi)
	}
	return RootOwned(fi)
}

// RootOwned accepts a regular file or a directory, not a symbolic link,
// owned by root and writable only by root: a recipe runs under one card,
// so only the package manager may write it.
func RootOwned(fi fs.FileInfo) error {
	m := fi.Mode()
	if m&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link", fi.Name())
	}
	if !m.IsRegular() && !m.IsDir() {
		return fmt.Errorf("%s is not a regular file", fi.Name())
	}
	if m.Perm()&0o022 != 0 {
		return fmt.Errorf("%s is writable by group or others", fi.Name())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 {
		return fmt.Errorf("%s is not owned by root", fi.Name())
	}
	return nil
}

// entries lists the directory after vetting it. A missing directory is
// "no recipes installed", not an error.
func (s *Store) entries() ([]fs.DirEntry, error) {
	fi, err := fs.Stat(s.FS, s.Dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", s.Dir)
	}
	if err := s.trusted(fi); err != nil {
		return nil, fmt.Errorf("recipe directory: %w", err)
	}
	return fs.ReadDir(s.FS, s.Dir)
}

func (s *Store) read(e fs.DirEntry) (Recipe, error) {
	if !e.Type().IsRegular() {
		return Recipe{}, fmt.Errorf("%s is not a regular file", e.Name())
	}
	fi, err := e.Info()
	if err != nil {
		return Recipe{}, err
	}
	if err := s.trusted(fi); err != nil {
		return Recipe{}, err
	}
	if fi.Size() > MaxFileBytes {
		return Recipe{}, fmt.Errorf("%s is larger than %d bytes", e.Name(), MaxFileBytes)
	}
	b, err := fs.ReadFile(s.FS, path.Join(s.Dir, e.Name()))
	if err != nil {
		return Recipe{}, err
	}
	r, err := Parse(b)
	if err != nil {
		return Recipe{}, err
	}
	if r.ID+".json" != e.Name() {
		return Recipe{}, fmt.Errorf("file name must be %s.json", r.ID)
	}
	return r, nil
}

// List returns every valid recipe sorted by id, and the files skipped.
func (s *Store) List() ([]Recipe, []Problem, error) {
	ents, err := s.entries()
	if err != nil {
		return nil, nil, err
	}
	var out []Recipe
	var probs []Problem
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if len(out) >= MaxRecipes {
			probs = append(probs, Problem{File: e.Name(), Reason: fmt.Sprintf("more than %d recipes", MaxRecipes)})
			continue
		}
		r, err := s.read(e)
		if err != nil {
			probs = append(probs, Problem{File: e.Name(), Reason: err.Error()})
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, probs, nil
}

// Get reads one recipe by id.
func (s *Store) Get(id string) (Recipe, error) {
	if !ValidID(id) {
		return Recipe{}, ErrNotFound
	}
	ents, err := s.entries()
	if err != nil {
		return Recipe{}, err
	}
	for _, e := range ents {
		if e.Name() == id+".json" {
			return s.read(e)
		}
	}
	return Recipe{}, ErrNotFound
}
