// Package catalog reads the curated model catalog shipped by
// jarvis-models-catalog (M2 contracts §4). Plan H owns the file; this
// package is a tolerant reader: unknown fields are ignored (the catalog may
// grow) and an entry that fails validation is dropped, never offered.
package catalog

import (
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
)

// Path is where jarvis-models-catalog installs the catalog.
const Path = "/usr/share/jarvis/models/catalog.json"

// Model is one catalog entry (M2 contracts §4, field names verbatim).
type Model struct {
	ID             string   `json:"id"`
	OllamaTag      string   `json:"ollamaTag"`
	DisplayName    string   `json:"displayName"`
	SizeBytes      int64    `json:"sizeBytes"`
	MinRamGB       float64  `json:"minRamGB"`
	MinVramGB      *float64 `json:"minVramGB"`
	Tier           string   `json:"tier"`
	ToolCalling    string   `json:"toolCalling"`
	Languages      []string `json:"languages"`
	RecommendedFor string   `json:"recommendedFor"`
}

var (
	idRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	tagRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,64})?$`)
	tiers = map[string]bool{"small": true, "medium": true, "large": true, "gpu": true}
)

// Valid reports why an entry cannot be offered, or nil.
func (m Model) Valid() error {
	switch {
	case !idRe.MatchString(m.ID):
		return fmt.Errorf("bad id %q", m.ID)
	case !tagRe.MatchString(m.OllamaTag):
		return fmt.Errorf("%s: bad ollamaTag %q", m.ID, m.OllamaTag)
	case m.DisplayName == "" || len(m.DisplayName) > 100:
		return fmt.Errorf("%s: bad displayName", m.ID)
	case m.SizeBytes <= 0 || m.MinRamGB <= 0:
		return fmt.Errorf("%s: sizes must be positive", m.ID)
	case m.MinVramGB != nil && *m.MinVramGB <= 0:
		return fmt.Errorf("%s: minVramGB must be positive or null", m.ID)
	case !tiers[m.Tier]:
		return fmt.Errorf("%s: bad tier %q", m.ID, m.Tier)
	case m.ToolCalling != "verified":
		return fmt.Errorf("%s: tool calling not verified", m.ID)
	}
	return nil
}

// Parse decodes a catalog document and keeps the valid entries, in order,
// first one wins on a duplicate id.
func Parse(b []byte) ([]Model, error) {
	var doc struct {
		Version int     `json:"version"`
		Models  []Model `json:"models"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	if doc.Version < 1 {
		return nil, fmt.Errorf("catalog: unsupported version %d", doc.Version)
	}
	out := []Model{}
	seen := map[string]bool{}
	for _, m := range doc.Models {
		if m.Valid() != nil || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		if m.Languages == nil {
			m.Languages = []string{}
		}
		out = append(out, m)
	}
	return out, nil
}

// Load reads and parses the catalog at path. A missing catalog is an empty
// list: "This computer" then has nothing to offer, which the UI explains.
func Load(f files.FS, path string) ([]Model, error) {
	b, err := f.ReadFile(path)
	if err != nil {
		if !f.Exists(path) {
			return []Model{}, nil
		}
		return nil, err
	}
	return Parse(b)
}

// Find returns the entry with id.
func Find(models []Model, id string) (Model, bool) {
	for _, m := range models {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}
