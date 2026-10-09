// Package modelstate reads and writes /var/lib/jarvis/model-state.json and
// the model-pending marker (M2 contracts §5). The installer backend writes
// them under /target during install; jarvis-model-fetch writes them on the
// installed system. jarvisd and the greeter only read.
package modelstate

import (
	"encoding/json"
	"fmt"
	"path"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
)

// Paths relative to the system root ("/" installed, "/target" during install).
const (
	Dir    = "/var/lib/jarvis"
	File   = Dir + "/model-state.json"
	Marker = Dir + "/model-pending"
)

// States (M2 contracts §5).
const (
	Pending     = "pending"
	Downloading = "downloading"
	Ready       = "ready"
	Failed      = "failed"
)

// State is the file's content, field names verbatim from the contract.
type State struct {
	ModelID   string `json:"modelId"`
	OllamaTag string `json:"ollamaTag"`
	State     string `json:"state"`
	Percent   int    `json:"percent"`
	Message   string `json:"message"`
	UpdatedAt string `json:"updatedAt"` // RFC 3339 UTC
}

// Write stores st under root atomically, world-readable (0644), in a 0755
// directory. UpdatedAt is set from now.
func Write(f files.FS, root string, st State, now time.Time) error {
	switch st.State {
	case Pending, Downloading, Ready, Failed:
	default:
		return fmt.Errorf("modelstate: unknown state %q", st.State)
	}
	if st.Percent < 0 || st.Percent > 100 {
		return fmt.Errorf("modelstate: percent %d out of range", st.Percent)
	}
	st.UpdatedAt = now.UTC().Format(time.RFC3339)
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := f.MkdirAll(path.Join(root, Dir), 0o755); err != nil {
		return err
	}
	return f.WriteFile(path.Join(root, File), append(b, '\n'), 0o644)
}

// Read loads the state under root.
func Read(f files.FS, root string) (State, error) {
	var st State
	b, err := f.ReadFile(path.Join(root, File))
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return st, fmt.Errorf("modelstate: %w", err)
	}
	return st, nil
}

// MarkPending creates the marker that starts jarvis-model-fetch.service.
func MarkPending(f files.FS, root string) error {
	if err := f.MkdirAll(path.Join(root, Dir), 0o755); err != nil {
		return err
	}
	return f.WriteFile(path.Join(root, Marker), nil, 0o644)
}

// ClearPending removes the marker.
func ClearPending(f files.FS, root string) error { return f.Remove(path.Join(root, Marker)) }

// IsPending reports whether the marker exists.
func IsPending(f files.FS, root string) bool { return f.Exists(path.Join(root, Marker)) }
