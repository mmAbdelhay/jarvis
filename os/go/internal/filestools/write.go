package filestools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/mmAbdelhay/jarvis/os/go/internal/fileops"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
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
			Describe:    func(ctx context.Context, raw json.RawMessage) (mcp.Description, error) { return w.describe(kind, raw) },
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

func decodeItems(raw json.RawMessage) ([]fileops.Item, error) {
	var in struct {
		Items []fileops.Item `json:"items"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if len(in.Items) < 1 || len(in.Items) > MaxItems {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeText.BadItems)
	}
	for _, it := range in.Items {
		if it.From == "" || len(it.From) > homepath.MaxPath || len(it.To) > homepath.MaxPath {
			return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeText.BadItem)
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
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", writeText.BadJournal)
	}
	res, err := w.Ops.Undo(in.JournalID)
	if errors.Is(err, fileops.ErrNoJournal) {
		return nil, mcp.Errorf(mcp.CodeNotFound, "%s", writeText.UnknownJournal)
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
func (w WriteDeps) describe(kind fileops.Kind, raw json.RawMessage) (mcp.Description, error) {
	items, err := decodeItems(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	it := items[0]
	paths := w.Ops.Paths
	d := mcp.Description{Source: mcp.SourceSystem}
	from, ferr := paths.Existing(it.From)
	fromShown := it.From
	if ferr == nil {
		fromShown = from.Display
	}
	switch kind {
	case fileops.Move, fileops.Copy:
		title := writeText.MoveTitle
		if kind == fileops.Copy {
			title = writeText.CopyTitle
		}
		to := it.To
		if dst, err := paths.New(it.To); err == nil {
			to = dst.Display
		} else if ferr == nil {
			ferr = err
		}
		d.Title = fmt.Sprintf(title, base(fromShown), to)
		d.Detail = fromShown + " → " + to
	case fileops.Rename:
		d.Title = fmt.Sprintf(writeText.RenameTitle, base(fromShown), it.To)
		d.Detail = fromShown + " → " + filepath.ToSlash(filepath.Join(filepath.Dir(fromShown), it.To))
		if ferr == nil {
			ferr = homepath.ValidName(it.To)
		}
	case fileops.Mkdir:
		p, err := paths.New(it.From)
		shown := it.From
		if err == nil {
			shown = p.Display
		}
		d.Title, d.Detail, ferr = fmt.Sprintf(writeText.MkdirTitle, shown), shown, err
	case fileops.Trash:
		d.Title = fmt.Sprintf(writeText.TrashTitle, base(fromShown))
		d.Detail = fmt.Sprintf(writeText.TrashDetail, fromShown)
	case fileops.Restore:
		ferr = nil
		d.Title = fmt.Sprintf(writeText.RestoreTitle, base(strings.TrimPrefix(it.From, fileops.TrashPrefix)))
		place := it.To
		if place == "" {
			place = it.From
		}
		d.Detail = fmt.Sprintf(writeText.RestoreDetail, place)
	}
	if ferr != nil {
		d.Detail += " · " + fmt.Sprintf(writeText.Cannot, mcp.AsToolError(ferr).Message)
	}
	return d, nil
}

func (w WriteDeps) describeUndo(_ context.Context, raw json.RawMessage) (mcp.Description, error) {
	var in struct {
		JournalID string `json:"journalId"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return mcp.Description{}, err
	}
	e, err := w.Ops.Journal.Load(in.JournalID)
	if err != nil {
		return mcp.Description{}, mcp.Errorf(mcp.CodeNotFound, "%s", writeText.UnknownJournal)
	}
	return mcp.Description{Title: writeText.UndoTitle, Detail: fmt.Sprintf(writeText.UndoDetail, len(e.Steps)), Source: mcp.SourceSystem}, nil
}
