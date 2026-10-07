// Package files is the filesystem seam of the installer backend and
// jarvis-model-fetch. Code names real absolute paths ("/target/etc/fstab");
// OS maps them under Root, so tests run the same code against a temp
// directory and production uses Root "".
package files

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
)

// FS is every file operation the installer and model fetcher perform.
type FS interface {
	ReadFile(name string) ([]byte, error)
	// WriteFile replaces name atomically (temp file + rename in the same
	// directory) with mode perm.
	WriteFile(name string, data []byte, perm fs.FileMode) error
	MkdirAll(name string, perm fs.FileMode) error
	Chmod(name string, perm fs.FileMode) error
	Chown(name string, uid, gid int) error
	Symlink(oldname, newname string) error
	Remove(name string) error
	Exists(name string) bool
	Glob(pattern string) ([]string, error)
	// ReadHead returns up to n bytes from the start of name (a file or a
	// block device).
	ReadHead(name string, n int) ([]byte, error)
}

// OS is FS on the real filesystem, under Root ("" in production). With
// RecordChown set, Chown records "path uid:gid" instead of calling chown(2),
// so tests need no root.
type OS struct {
	Root        string
	RecordChown bool

	mu      sync.Mutex
	chowned []string
}

func (o *OS) p(name string) string {
	if o.Root == "" {
		return name
	}
	return filepath.Join(o.Root, name)
}

func (o *OS) ReadFile(name string) ([]byte, error) { return os.ReadFile(o.p(name)) }

func (o *OS) WriteFile(name string, data []byte, perm fs.FileMode) error {
	dst := o.p(name)
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

func (o *OS) MkdirAll(name string, perm fs.FileMode) error { return os.MkdirAll(o.p(name), perm) }
func (o *OS) Chmod(name string, perm fs.FileMode) error    { return os.Chmod(o.p(name), perm) }

func (o *OS) Chown(name string, uid, gid int) error {
	if o.RecordChown {
		if _, err := os.Lstat(o.p(name)); err != nil {
			return err
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		o.chowned = append(o.chowned, name+" "+strconv.Itoa(uid)+":"+strconv.Itoa(gid))
		return nil
	}
	return os.Lchown(o.p(name), uid, gid)
}

// Chowned returns what Chown recorded (RecordChown only), sorted.
func (o *OS) Chowned() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := append([]string(nil), o.chowned...)
	sort.Strings(out)
	return out
}

func (o *OS) Symlink(oldname, newname string) error { return os.Symlink(oldname, o.p(newname)) }

func (o *OS) Remove(name string) error {
	err := os.Remove(o.p(name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (o *OS) Exists(name string) bool {
	_, err := os.Lstat(o.p(name))
	return err == nil
}

// Glob returns matches as absolute paths without Root.
func (o *OS) Glob(pattern string) ([]string, error) {
	m, err := filepath.Glob(o.p(pattern))
	if err != nil || o.Root == "" {
		return m, err
	}
	for i := range m {
		m[i] = "/" + mustRel(o.Root, m[i])
	}
	return m, nil
}

func (o *OS) ReadHead(name string, n int) ([]byte, error) {
	f, err := os.Open(o.p(name))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, n)
	k, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buf[:k], nil
}

func mustRel(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return p
	}
	return filepath.ToSlash(r)
}

var _ FS = (*OS)(nil)
