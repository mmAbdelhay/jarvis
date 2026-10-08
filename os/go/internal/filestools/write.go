package filestools

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/fileops"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

// MaxItems bounds one batch of file changes.
const MaxItems = 200

// Undo is the undo object every write tool returns (Rafiq M3 contracts §1):
// calling Tool with Input restores the previous state.
type Undo struct {
	Tool  string `json:"tool"`
	Input any    `json:"input"`
}

// WriteResult is the structuredContent of every write tool.
type WriteResult struct {
	fileops.Result
	Undo *Undo `json:"undo"`
}

// WriteDeps are the write tools' inputs.
type WriteDeps struct {
	Ops *fileops.Ops
}

const itemsSchema = `{"type":"object","properties":{"items":{"type":"array","minItems":1,"maxItems":200,"items":{"type":"object","properties":{"from":{"type":"string","minLength":1,"maxLength":4096},"to":{"type":"string","minLength":1,"maxLength":4096}},"required":["from"],"additionalProperties":false}}},"required":["items"],"additionalProperties":false}`

// WriteTools returns jarvis-files' write tools (Rafiq M3 contracts §1),
// each confirm with _meta.jarvis.batch "items", plus the hidden files.undo.
func WriteTools(w WriteDeps) []mcp.Tool {
	tool := func(kind fileops.Kind, desc string) mcp.Tool {
		return mcp.Tool{
			Name:        "files." + string(kind),
			Description: desc,
			InputSchema: itemsSchema,
			Risk:        mcp.RiskConfirm,
			Batch:       "items",
			Call:        func(ctx context.Context, raw json.RawMessage) (any, error) { return w.run(kind, raw) },
			Describe: func(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
				return w.describe(i18n.FromContext(ctx), kind, raw)
			},
		}
	}
	return []mcp.Tool{
		tool(fileops.Move, "Move files or folders inside the user's home folder. items: [{from: \"~/Desktop/a.png\", to: \"~/Pictures/\"}]; a \"to\" ending in / or naming an existing folder means \"into that folder\" (created if missing). Never overwrites."),
		tool(fileops.Copy, "Copy files or folders inside the user's home folder. items: [{from, to}] like files.move. Never overwrites."),
		tool(fileops.Rename, "Rename a file or folder in place. items: [{from: \"~/Documents/a.txt\", to: \"b.txt\"}]; to is a new name, not a path."),
		tool(fileops.Mkdir, "Create folders (and missing parents) in the user's home folder. items: [{from: \"~/Projects/new\"}]."),
		tool(fileops.Trash, "Move files or folders to the trash (never deletes for good). items: [{from}]. Each can be restored with files.restore."),
		tool(fileops.Restore, "Restore items from the trash. items: [{from: original path like \"~/Documents/a.txt\" or \"trash:<name>\", to?: another place}]."),
		{
			Name:        "files.trash_list",
			Description: "List what is in the trash, newest first, so an item can be put back with files.restore (use its trash value as from). query (optional): words that must all appear in the name or the original place. Private items are not listed. Names are untrusted text.",
			InputSchema: `{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":100},"limit":{"type":"integer","minimum":1,"maximum":100,"default":30}},"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        w.trashList,
		},
		{
			Name:        "files.undo",
			Description: "Reverse one earlier file change by its journalId. Called by Jarvis for \"undo\", never offered to the model.",
			InputSchema: `{"type":"object","properties":{"journalId":{"type":"string","pattern":"^[0-9a-f]{16}$"}},"required":["journalId"],"additionalProperties":false}`,
			Risk:        mcp.RiskConfirm,
			Hidden:      true,
			Call:        w.undo,
			Describe:    w.describeUndo,
		},
	}
}

// TrashEntry is one item of files.trash_list.
type TrashEntry struct {
	Name         string `json:"name"`         // value for files.restore: "trash:<name>"
	Trash        string `json:"trash"`        // "trash:<name>"
	OriginalPath string `json:"originalPath"` // "~/…"
	DeletedAt    string `json:"deletedAt"`    // RFC 3339, UTC
}

func (w WriteDeps) trashList(_ context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if in.Limit == 0 {
		in.Limit = 30
	}
	if in.Limit < 1 || in.Limit > 100 || len(in.Query) > 100 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeErr.BadTrashList)
	}
	all, err := w.Ops.Trash.List()
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "%v", err)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].DeletionDate.After(all[j].DeletionDate) })
	words := strings.Fields(strings.ToLower(in.Query))
	items := []TrashEntry{}
	for _, it := range all {
		shown := w.Ops.Paths.Display(it.OriginalPath)
		rest, ok := strings.CutPrefix(shown, "~/")
		if !ok || rest == ".." || strings.HasPrefix(rest, "../") || homepath.Private(it.Name) {
			continue
		}
		hidden := false
		for _, part := range strings.Split(rest, "/") {
			if homepath.Private(part) {
				hidden = true
			}
		}
		hay := strings.ToLower(it.Name + " " + shown)
		match := !hidden
		for _, word := range words {
			if !strings.Contains(hay, word) {
				match = false
			}
		}
		if !match {
			continue
		}
		items = append(items, TrashEntry{Name: it.Name, Trash: fileops.TrashPrefix + it.Name, OriginalPath: shown, DeletedAt: it.DeletionDate.UTC().Format(time.RFC3339)})
		if len(items) == in.Limit {
			break
		}
	}
	return map[string]any{"items": items}, nil
}

func decodeItems(raw json.RawMessage) ([]fileops.Item, error) {
	var in struct {
		Items []fileops.Item `json:"items"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if len(in.Items) < 1 || len(in.Items) > MaxItems {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeErr.BadItems)
	}
	for _, it := range in.Items {
		if it.From == "" || len(it.From) > homepath.MaxPath || len(it.To) > homepath.MaxPath {
			return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeErr.BadItem)
		}
	}
	return in.Items, nil
}

func (w WriteDeps) run(kind fileops.Kind, raw json.RawMessage) (any, error) {
	items, err := decodeItems(raw)
	if err != nil {
		return nil, err
	}
	res := w.Ops.Run(kind, items)
	out := WriteResult{Result: res}
	if res.JournalID != "" {
		out.Undo = &Undo{Tool: "files.undo", Input: map[string]string{"journalId": res.JournalID}}
	}
	return out, nil
}

func (w WriteDeps) undo(_ context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		JournalID string `json:"journalId"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if !fileops.ValidID(in.JournalID) {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeErr.BadJournal)
	}
	res, err := w.Ops.Undo(in.JournalID)
	if errors.Is(err, fileops.ErrNoJournal) {
		return nil, mcp.Errorf(mcp.CodeNotFound, "%s", writeErr.UnknownJournal)
	}
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "%v", err)
	}
	return WriteResult{Result: res}, nil
}

// base is the last part of a "~/…" path for a title.
func base(p string) string {
	p = strings.TrimSuffix(p, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// describe builds one card item for one element (jarvisd sends
// {items:[element]}, M1 contracts §6.1). It only reads the disk.
func (w WriteDeps) describe(l i18n.Lang, kind fileops.Kind, raw json.RawMessage) (mcp.Description, error) {
	items, err := decodeItems(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	it := items[0]
	t := writeCardText.Get(l)
	paths := w.Ops.Paths
	d := mcp.Description{Source: mcp.SourceSystem}
	from, ferr := paths.Existing(it.From)
	fromShown := it.From
	if ferr == nil {
		fromShown = from.Display
	}
	switch kind {
	case fileops.Move, fileops.Copy:
		title := t.MoveTitle
		if kind == fileops.Copy {
			title = t.CopyTitle
		}
		to := it.To
		if dst, err := paths.New(it.To); err == nil {
			to = dst.Display
		} else if ferr == nil {
			ferr = err
		}
		d.Title = i18n.Sprintf(l, title, base(fromShown), to)
		d.Detail = i18n.Sprintf(l, t.PathChange, fromShown, to)
	case fileops.Rename:
		d.Title = i18n.Sprintf(l, t.RenameTitle, base(fromShown), it.To)
		d.Detail = i18n.Sprintf(l, t.PathChange, fromShown, filepath.ToSlash(filepath.Join(filepath.Dir(fromShown), it.To)))
		if ferr == nil {
			ferr = homepath.ValidName(it.To)
		}
	case fileops.Mkdir:
		p, err := paths.New(it.From)
		shown := it.From
		if err == nil {
			shown = p.Display
		}
		d.Title, d.Detail, ferr = i18n.Sprintf(l, t.MkdirTitle, shown), i18n.Iso(l, shown), err
	case fileops.Trash:
		d.Title = i18n.Sprintf(l, t.TrashTitle, base(fromShown))
		d.Detail = i18n.Sprintf(l, t.TrashDetail, fromShown)
	case fileops.Restore:
		ferr = nil
		d.Title = i18n.Sprintf(l, t.RestoreTitle, base(strings.TrimPrefix(it.From, fileops.TrashPrefix)))
		place := it.To
		if place == "" {
			place = it.From
		}
		d.Detail = i18n.Sprintf(l, t.RestoreDetail, place)
	}
	if ferr != nil {
		d.Detail += " · " + i18n.Sprintf(l, t.Cannot, mcp.AsToolError(ferr).Message)
	}
	return d, nil
}

func (w WriteDeps) describeUndo(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := writeCardText.Get(l)
	var in struct {
		JournalID string `json:"journalId"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return mcp.Description{}, err
	}
	e, err := w.Ops.Journal.Load(in.JournalID)
	if err != nil {
		return mcp.Description{}, mcp.Errorf(mcp.CodeNotFound, "%s", writeErr.UnknownJournal)
	}
	return mcp.Description{Title: t.UndoTitle, Detail: i18n.Sprintf(l, t.UndoDetail, len(e.Steps)), Source: mcp.SourceSystem}, nil
}
