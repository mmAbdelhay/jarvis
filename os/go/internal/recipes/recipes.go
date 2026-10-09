// Package recipes reads Rafiq setup recipes (Rafiq M4 contracts §4, §6):
// curated, reviewed multi-step plans that the jarvis-recipes package
// installs as /usr/share/jarvis/recipes/<id>.json. This package owns the
// file format, the trust checks on the files, the digest that ties a card
// to the bytes it showed, and the host requirements. Which tools a step
// may use is the recipe validator's allowlist, not this package's.
package recipes

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"unicode"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
)

const (
	// DefaultDir is the recipe directory relative to the root file system.
	DefaultDir   = "usr/share/jarvis/recipes"
	MaxFileBytes = 64 << 10
	MaxRecipes   = 100
	MaxSteps     = 20
	maxTitle     = 120
	maxDesc      = 500
)

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

// ValidID reports whether id can name a recipe (and its file).
func ValidID(id string) bool { return idRe.MatchString(id) }

// Text is one string in both card languages.
type Text struct {
	EN string `json:"en"`
	AR string `json:"ar"`
}

// In returns the text for l.
func (t Text) In(l i18n.Lang) string {
	if l == i18n.AR {
		return t.AR
	}
	return t.EN
}

// Step is one tool call of a recipe.
type Step struct {
	Tool  string          `json:"tool"`
	Input json.RawMessage `json:"input"`
	Title Text            `json:"title"`
}

// Requires is what the computer must be.
type Requires struct {
	OS       string  `json:"os"`
	MinRAMGB float64 `json:"minRamGB,omitempty"`
}

// Recipe is one recipe file.
type Recipe struct {
	ID          string   `json:"id"`
	Title       Text     `json:"title"`
	Description Text     `json:"description"`
	Steps       []Step   `json:"steps"`
	Requires    Requires `json:"requires"`
	// Available is false for a recipe that is shipped but cannot run yet
	// (contracts §6.15); absent means true.
	Available *bool `json:"available,omitempty"`
	// Digest is the first 16 hex digits of the file's SHA-256, so a card can
	// be tied to the bytes it showed.
	Digest string `json:"-"`
}

// IsAvailable reports whether the recipe may be offered to run.
func (r Recipe) IsAvailable() bool { return r.Available == nil || *r.Available }

// Parse decodes and checks one recipe file. Unknown fields are refused at
// every level (step inputs are kept raw for the tool to check).
func Parse(b []byte) (Recipe, error) {
	if len(b) > MaxFileBytes {
		return Recipe{}, fmt.Errorf("recipe is larger than %d bytes", MaxFileBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var r Recipe
	if err := dec.Decode(&r); err != nil {
		return Recipe{}, fmt.Errorf("bad recipe JSON: %v", err)
	}
	if dec.More() {
		return Recipe{}, fmt.Errorf("bad recipe JSON: trailing data")
	}
	if !ValidID(r.ID) {
		return Recipe{}, fmt.Errorf("id %q is not lower-case letters, digits and - (at most 48)", r.ID)
	}
	if err := checkText("title", r.Title, maxTitle); err != nil {
		return Recipe{}, err
	}
	if err := checkText("description", r.Description, maxDesc); err != nil {
		return Recipe{}, err
	}
	if len(r.Steps) < 1 || len(r.Steps) > MaxSteps {
		return Recipe{}, fmt.Errorf("a recipe has 1 to %d steps, not %d", MaxSteps, len(r.Steps))
	}
	for i, s := range r.Steps {
		if s.Tool == "" {
			return Recipe{}, fmt.Errorf("step %d has no tool", i+1)
		}
		if in := bytes.TrimSpace(s.Input); len(in) == 0 || in[0] != '{' {
			return Recipe{}, fmt.Errorf("step %d input must be a JSON object", i+1)
		}
		if err := checkText(fmt.Sprintf("step %d title", i+1), s.Title, maxTitle); err != nil {
			return Recipe{}, err
		}
	}
	if !ValidID(r.Requires.OS) {
		return Recipe{}, fmt.Errorf("requires.os must be an os-release ID like rafiq")
	}
	if r.Requires.MinRAMGB < 0 || r.Requires.MinRAMGB > 1024 {
		return Recipe{}, fmt.Errorf("requires.minRamGB must be 0 to 1024")
	}
	sum := sha256.Sum256(b)
	r.Digest = hex.EncodeToString(sum[:8])
	return r, nil
}

func checkText(what string, t Text, max int) error {
	for _, v := range []struct{ lang, s string }{{"en", t.EN}, {"ar", t.AR}} {
		n := utf8.RuneCountInString(v.s)
		if n == 0 {
			return fmt.Errorf("%s.%s is empty", what, v.lang)
		}
		if n > max {
			return fmt.Errorf("%s.%s is longer than %d characters", what, v.lang, max)
		}
		for _, r := range v.s {
			if unicode.IsControl(r) {
				return fmt.Errorf("%s.%s contains a control character", what, v.lang)
			}
		}
	}
	return nil
}
