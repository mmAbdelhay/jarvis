// Package fileops performs jarvis-files' write operations (Rafiq M3
// contracts §1: move, copy, rename, mkdir, trash, restore) inside $HOME and
// journals each successful call so "undo last file change" can reverse it.
// Nothing is ever deleted for good: trash goes to the freedesktop Trash,
// and undoing a copy trashes the copy.
package fileops

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/trash"
)

// Item is one batch element as the model sends it.
type Item struct {
	From string `json:"from"`
	To   string `json:"to,omitempty"`
}

// Done is one finished item ("~/…" paths).
type Done struct {
	Kind Kind   `json:"kind"`
	From string `json:"from"`
	To   string `json:"to,omitempty"`
}

// Failed is one item that did not happen, and why.
type Failed struct {
	From    string   `json:"from"`
	To      string   `json:"to,omitempty"`
	Code    mcp.Code `json:"code"`
	Message string   `json:"message"`
}

// Result is every file tool's structuredContent core (contracts §1:
// {done, failed, journalId}); JournalID is "" when nothing changed.
type Result struct {
	Done      []Done   `json:"done"`
	Failed    []Failed `json:"failed"`
	JournalID string   `json:"journalId"`
}

// TrashPrefix names a trash item directly in files.restore ("trash:<name>").
const TrashPrefix = "trash:"

// Ops performs file changes for one user.
type Ops struct {
	Paths   homepath.Resolver
	Trash   trash.Trash
	Journal Journal
	Now     func() time.Time // nil: time.Now
	NewID   func() string    // nil: 16 random hex digits
	// Copy limits per item; 0: 10 GiB and 20000 entries.
	MaxCopyBytes   int64
	MaxCopyEntries int

	mu sync.Mutex
}

func (o *Ops) now() time.Time {
	if o.Now == nil {
		return time.Now()
	}
	return o.Now()
}

func (o *Ops) newID() string {
	if o.NewID != nil {
		return o.NewID()
	}
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (o *Ops) maxBytes() int64 {
	if o.MaxCopyBytes <= 0 {
		return 10 << 30
	}
	return o.MaxCopyBytes
}

func (o *Ops) maxEntries() int {
	if o.MaxCopyEntries <= 0 {
		return 20000
	}
	return o.MaxCopyEntries
}

func fail(it Item, err error) Failed {
	te := mcp.AsToolError(err)
	return Failed{From: it.From, To: it.To, Code: te.Code, Message: te.Message}
}

func failedf(code mcp.Code, format string, a ...any) error { return mcp.Errorf(code, format, a...) }

// fingerprint records what sits at abs now.
func fingerprint(s *Step, abs string) {
	st, err := os.Lstat(abs)
	if err != nil {
		return
	}
	s.Dir = st.IsDir()
	if !s.Dir {
		s.Size, s.ModNs = st.Size(), st.ModTime().UnixNano()
	}
}

// unchanged reports whether abs still matches the step's fingerprint.
func unchanged(s Step, abs string) bool {
	st, err := os.Lstat(abs)
	if err != nil || st.IsDir() != s.Dir {
		return false
	}
	return s.Dir || (st.Size() == s.Size && st.ModTime().UnixNano() == s.ModNs)
}

// Run performs one batch. Each item succeeds or fails on its own; the
// successful ones become one journal entry.
func (o *Ops) Run(kind Kind, items []Item) Result {
	o.mu.Lock()
	defer o.mu.Unlock()
	res := Result{Done: []Done{}, Failed: []Failed{}}
	var steps []Step
	for _, it := range items {
		st, done, err := o.one(kind, it)
		if err != nil {
			res.Failed = append(res.Failed, fail(it, err))
			continue
		}
		steps = append(steps, st...)
		res.Done = append(res.Done, done)
	}
	if len(steps) > 0 {
		e := Entry{ID: o.newID(), CreatedAt: o.now().UTC().Format(time.RFC3339Nano), Steps: steps}
		if err := o.Journal.Save(e); err == nil {
			res.JournalID = e.ID
		}
	}
	return res
}

func (o *Ops) one(kind Kind, it Item) ([]Step, Done, error) {
	switch kind {
	case Move, Copy:
		return o.moveOrCopy(kind, it)
	case Rename:
		return o.rename(it)
	case Mkdir:
		return o.mkdir(it)
	case Trash:
		return o.trash(it)
	case Restore:
		return o.restore(it)
	}
	return nil, Done{}, failedf(mcp.CodeInvalid, "unknown operation %q", kind)
}

// source resolves an existing item that may be changed (never $HOME).
func (o *Ops) source(p string) (homepath.Path, error) {
	src, err := o.Paths.Existing(p)
	if err != nil {
		return src, err
	}
	if src.IsHome() {
		return src, failedf(mcp.CodeDenied, "your home folder itself cannot be moved, copied or trashed")
	}
	return src, nil
}

// ensureDir creates abs and its missing parents (inside $HOME, already
// resolved by homepath.New) and returns mkdir steps, outermost first.
func ensureDir(abs string) ([]Step, error) {
	var missing []string
	for d := abs; ; d = filepath.Dir(d) {
		if _, err := os.Lstat(d); err == nil {
			break
		}
		missing = append([]string{d}, missing...)
		if filepath.Dir(d) == d {
			break
		}
	}
	var steps []Step
	for _, d := range missing {
		if err := os.Mkdir(d, 0o755); err != nil {
			return steps, err
		}
		steps = append(steps, Step{Kind: Mkdir, From: d, Dir: true})
	}
	return steps, nil
}

// destination works out where a move or copy lands: into `to` when it is
// an existing folder or ends with "/", else exactly at `to`.
func (o *Ops) destination(src homepath.Path, to string) (homepath.Path, bool, error) {
	if to == "" {
		return homepath.Path{}, false, failedf(mcp.CodeInvalid, "a destination (to) is needed")
	}
	dst, err := o.Paths.New(to)
	if err != nil {
		return dst, false, err
	}
	intoFolder := strings.HasSuffix(to, "/")
	if dst.Exists {
		st, err := os.Stat(dst.Target)
		if err == nil && st.IsDir() {
			intoFolder = true
		}
	}
	if !intoFolder {
		return dst, false, nil
	}
	folder := dst.Target
	inner, err := o.Paths.New(o.Paths.Display(folder) + "/" + filepath.Base(src.Abs))
	if err != nil {
		return inner, false, err
	}
	return inner, !dst.Exists, nil
}

func within(child, parent string) bool {
	return child == parent || strings.HasPrefix(child, parent+string(filepath.Separator))
}

func (o *Ops) moveOrCopy(kind Kind, it Item) ([]Step, Done, error) {
	src, err := o.source(it.From)
	if err != nil {
		return nil, Done{}, err
	}
	dst, _, err := o.destination(src, it.To)
	if err != nil {
		return nil, Done{}, err
	}
	if dst.Exists {
		return nil, Done{}, failedf(mcp.CodeInvalid, "%s already exists; nothing is overwritten", dst.Display)
	}
	if within(dst.Abs, src.Abs) || (kind == Copy && within(dst.Abs, src.Target)) {
		return nil, Done{}, failedf(mcp.CodeInvalid, "%s cannot go inside itself", src.Display)
	}
	steps, err := ensureDir(filepath.Dir(dst.Abs))
	if err != nil {
		return steps, Done{}, failedf(mcp.CodeFailed, "cannot create %s: %v", o.Paths.Display(filepath.Dir(dst.Abs)), err)
	}
	step := Step{Kind: kind, From: src.Abs, To: dst.Abs}
	if kind == Move {
		if err := os.Rename(src.Abs, dst.Abs); err != nil {
			if errors.Is(err, syscall.EXDEV) {
				return steps, Done{}, failedf(mcp.CodeInvalid, "%s and %s are on different drives; copy instead", src.Display, dst.Display)
			}
			return steps, Done{}, failedf(mcp.CodeFailed, "%s: %v", src.Display, err)
		}
	} else {
		if err := o.copyTree(src.Target, dst.Abs); err != nil {
			return steps, Done{}, err
		}
	}
	fingerprint(&step, dst.Abs)
	return append(steps, step), Done{Kind: kind, From: src.Display, To: o.Paths.Display(dst.Abs)}, nil
}

func (o *Ops) rename(it Item) ([]Step, Done, error) {
	src, err := o.source(it.From)
	if err != nil {
		return nil, Done{}, err
	}
	if err := homepath.ValidName(it.To); err != nil {
		return nil, Done{}, err
	}
	dstAbs := filepath.Join(filepath.Dir(src.Abs), it.To)
	if _, err := os.Lstat(dstAbs); err == nil {
		return nil, Done{}, failedf(mcp.CodeInvalid, "%s already exists; nothing is overwritten", o.Paths.Display(dstAbs))
	}
	if err := os.Rename(src.Abs, dstAbs); err != nil {
		return nil, Done{}, failedf(mcp.CodeFailed, "%s: %v", src.Display, err)
	}
	step := Step{Kind: Rename, From: src.Abs, To: dstAbs}
	fingerprint(&step, dstAbs)
	return []Step{step}, Done{Kind: Rename, From: src.Display, To: o.Paths.Display(dstAbs)}, nil
}

func (o *Ops) mkdir(it Item) ([]Step, Done, error) {
	if it.To != "" {
		return nil, Done{}, failedf(mcp.CodeInvalid, "mkdir takes only from (the folder to create)")
	}
	p, err := o.Paths.New(it.From)
	if err != nil {
		return nil, Done{}, err
	}
	if p.Exists {
		return nil, Done{}, failedf(mcp.CodeInvalid, "%s already exists", p.Display)
	}
	steps, err := ensureDir(p.Abs)
	if err != nil {
		return steps, Done{}, failedf(mcp.CodeFailed, "%s: %v", p.Display, err)
	}
	return steps, Done{Kind: Mkdir, From: p.Display}, nil
}

func (o *Ops) trash(it Item) ([]Step, Done, error) {
	if it.To != "" {
		return nil, Done{}, failedf(mcp.CodeInvalid, "trash takes only from")
	}
	src, err := o.source(it.From)
	if err != nil {
		return nil, Done{}, err
	}
	if within(o.Trash.Dir, src.Abs) {
		return nil, Done{}, failedf(mcp.CodeDenied, "%s holds the trash itself", src.Display)
	}
	step := Step{Kind: Trash, From: src.Abs}
	fingerprint(&step, src.Abs)
	item, err := o.Trash.Put(src.Abs)
	if errors.Is(err, trash.ErrOtherDevice) {
		return nil, Done{}, failedf(mcp.CodeInvalid, "%s is on another drive than your trash", src.Display)
	}
	if err != nil {
		return nil, Done{}, failedf(mcp.CodeFailed, "%s: %v", src.Display, err)
	}
	step.TrashName = item.Name
	return []Step{step}, Done{Kind: Trash, From: src.Display, To: TrashPrefix + item.Name}, nil
}

// restore takes "trash:<name>" or the original "~/…" path, and puts the
// item back at its original place or at `to`.
func (o *Ops) restore(it Item) ([]Step, Done, error) {
	var item trash.Item
	var err error
	if name, ok := strings.CutPrefix(it.From, TrashPrefix); ok {
		item, err = o.Trash.Get(name)
	} else {
		var p homepath.Path
		p, err = o.Paths.New(it.From)
		if err != nil {
			return nil, Done{}, err
		}
		item, err = o.Trash.Find(p.Abs)
	}
	if err != nil {
		return nil, Done{}, failedf(mcp.CodeNotFound, "%s is not in the trash", it.From)
	}
	if err := o.checkTrashedPublic(item); err != nil {
		return nil, Done{}, err
	}
	target := it.To
	if target == "" {
		target = o.Paths.Display(item.OriginalPath)
	}
	dst, err := o.Paths.New(target)
	if err != nil {
		return nil, Done{}, err
	}
	if dst.Exists {
		return nil, Done{}, failedf(mcp.CodeInvalid, "%s already exists; nothing is overwritten", dst.Display)
	}
	steps, err := ensureDir(filepath.Dir(dst.Abs))
	if err != nil {
		return steps, Done{}, failedf(mcp.CodeFailed, "%s: %v", dst.Display, err)
	}
	if err := o.Trash.Restore(item.Name, dst.Abs); err != nil {
		return steps, Done{}, failedf(mcp.CodeFailed, "%s: %v", dst.Display, err)
	}
	step := Step{Kind: Restore, From: TrashPrefix + item.Name, To: dst.Abs}
	fingerprint(&step, dst.Abs)
	return append(steps, step), Done{Kind: Restore, From: TrashPrefix + item.Name, To: dst.Display}, nil
}

// checkTrashedPublic refuses to restore an item that was private (hidden or
// key-like) or that came from outside $HOME, wherever it would land.
func (o *Ops) checkTrashedPublic(item trash.Item) error {
	deny := func() error {
		return failedf(mcp.CodeDenied, "%s is private or was not in your home folder, so it stays in the trash", TrashPrefix+item.Name)
	}
	if homepath.Private(item.Name) {
		return deny()
	}
	shown := o.Paths.Display(item.OriginalPath)
	rest, ok := strings.CutPrefix(shown, "~/")
	if !ok || rest == ".." || strings.HasPrefix(rest, "../") {
		return deny()
	}
	for _, part := range strings.Split(rest, "/") {
		if homepath.Private(part) {
			return deny()
		}
	}
	return nil
}

// copyTree copies src (file, folder or link, not followed below the top)
// to dst through a hidden partial name, so a failed copy leaves nothing.
func (o *Ops) copyTree(src, dst string) error {
	var bytes int64
	entries := 0
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		entries++
		if entries > o.maxEntries() {
			return failedf(mcp.CodeInvalid, "more than %d files; too many to copy at once", o.maxEntries())
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return err
			}
			bytes += info.Size()
			if bytes > o.maxBytes() {
				return failedf(mcp.CodeInvalid, "more than %d GiB; too big to copy at once", o.maxBytes()>>30)
			}
		}
		return nil
	})
	if err != nil {
		var te *mcp.ToolError
		if errors.As(err, &te) {
			return te
		}
		return failedf(mcp.CodeFailed, "cannot read %s: %v", o.Paths.Display(src), err)
	}
	partial := filepath.Join(filepath.Dir(dst), ".jarvis-partial-"+o.newID())
	if err := copyAny(src, partial); err != nil {
		os.RemoveAll(partial) // only ever our own half-written copy
		return failedf(mcp.CodeFailed, "copy failed: %v", err)
	}
	if err := os.Rename(partial, dst); err != nil {
		os.RemoveAll(partial)
		return failedf(mcp.CodeFailed, "copy failed: %v", err)
	}
	return nil
}

func copyAny(src, dst string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case st.Mode()&fs.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	case st.IsDir():
		if err := os.Mkdir(dst, 0o700); err != nil {
			return err
		}
		ents, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range ents {
			if err := copyAny(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		if err := os.Chmod(dst, st.Mode().Perm()); err != nil {
			return err
		}
		return os.Chtimes(dst, st.ModTime(), st.ModTime())
	case st.Mode().IsRegular():
		return copyFile(src, dst, st)
	default:
		return nil // devices, FIFOs and sockets are skipped
	}
}

func copyFile(src, dst string, st fs.FileInfo) error {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, st.Mode().Perm()&0o777)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, st.ModTime(), st.ModTime())
}

// Undo reverses journal entry id, newest step first. A step whose result
// was changed since (different size or time, or gone) is skipped and
// reported; the entry is kept with only the steps that could not be undone.
func (o *Ops) Undo(id string) (Result, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	e, err := o.Journal.Load(id)
	if err != nil {
		return Result{}, err
	}
	res := Result{Done: []Done{}, Failed: []Failed{}}
	var left []Step
	for i := len(e.Steps) - 1; i >= 0; i-- {
		s := e.Steps[i]
		done, err := o.undoStep(s)
		if err != nil {
			left = append([]Step{s}, left...)
			res.Failed = append(res.Failed, fail(o.stepItem(s), err))
			continue
		}
		res.Done = append(res.Done, done)
	}
	if len(left) == 0 {
		o.Journal.Delete(id)
	} else {
		e.Steps = left
		o.Journal.Save(e)
		res.JournalID = id
	}
	return res, nil
}

// stepItem describes a step that could not be undone, in "~/…" form.
func (o *Ops) stepItem(s Step) Item {
	switch s.Kind {
	case Mkdir:
		return Item{From: o.Paths.Display(s.From)}
	case Trash:
		return Item{From: TrashPrefix + s.TrashName, To: o.Paths.Display(s.From)}
	}
	return Item{From: o.Paths.Display(s.To), To: o.Paths.Display(s.From)}
}

func (o *Ops) undoStep(s Step) (Done, error) {
	show := o.Paths.Display
	changed := func(p string) error {
		return failedf(mcp.CodeInvalid, "%s changed since, so it was left as it is", show(p))
	}
	switch s.Kind {
	case Move, Rename:
		if !unchanged(s, s.To) {
			return Done{}, changed(s.To)
		}
		if _, err := os.Lstat(s.From); err == nil {
			return Done{}, failedf(mcp.CodeInvalid, "%s is taken again, so %s stayed", show(s.From), show(s.To))
		}
		if _, err := ensureDir(filepath.Dir(s.From)); err != nil {
			return Done{}, failedf(mcp.CodeFailed, "%v", err)
		}
		if err := os.Rename(s.To, s.From); err != nil {
			return Done{}, failedf(mcp.CodeFailed, "%v", err)
		}
		return Done{Kind: s.Kind, From: show(s.To), To: show(s.From)}, nil
	case Copy, Restore:
		if !unchanged(s, s.To) {
			return Done{}, changed(s.To)
		}
		item, err := o.Trash.Put(s.To)
		if err != nil {
			return Done{}, failedf(mcp.CodeFailed, "%v", err)
		}
		return Done{Kind: Trash, From: show(s.To), To: TrashPrefix + item.Name}, nil
	case Mkdir:
		if fi, err := os.Lstat(s.From); err != nil || !fi.IsDir() {
			return Done{}, changed(s.From)
		}
		if err := os.Remove(s.From); err != nil {
			return Done{}, failedf(mcp.CodeInvalid, "%s is not empty any more, so it was kept", show(s.From))
		}
		return Done{Kind: Mkdir, From: show(s.From)}, nil
	case Trash:
		if _, err := os.Lstat(s.From); err == nil {
			return Done{}, failedf(mcp.CodeInvalid, "%s is taken again, so the trashed item stayed in the trash", show(s.From))
		}
		if err := o.Trash.Restore(s.TrashName, s.From); err != nil {
			return Done{}, failedf(mcp.CodeFailed, "%s: %v", show(s.From), err)
		}
		return Done{Kind: Restore, From: TrashPrefix + s.TrashName, To: show(s.From)}, nil
	}
	return Done{}, fmt.Errorf("unknown step %q", s.Kind)
}
