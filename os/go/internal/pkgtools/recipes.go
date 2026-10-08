package pkgtools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/recipes"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// jarvis-pkg only lists recipes. jarvisd runs them itself, one card item
// per step, calling each step's tool on its own server (Rafiq M4 contracts
// §6.1, which overrides the plan's recipes.run). The step allowlist below
// is the same set jarvisd enforces at run time and T's schema enforces
// statically (§6.2).

// recipeSteps maps each allowed step tool to a static check of its input.
// `note` is the non-executing instruction step shown on the card.
var recipeSteps = map[string]func(json.RawMessage) error{
	"pkg.install": func(raw json.RawMessage) error {
		_, err := decodeItems(raw)
		return err
	},
	"svc.restart": func(raw json.RawMessage) error {
		var in struct {
			Unit  string `json:"unit"`
			Scope string `json:"scope"`
		}
		if err := mcp.DecodeArgs(raw, &in); err != nil {
			return err
		}
		if in.Scope != "" && in.Scope != "system" && in.Scope != "user" {
			return mcp.Errorf(mcp.CodeInvalid, "scope must be system or user")
		}
		if in.Scope == "user" {
			if err := validate.UnitName(in.Unit); err != nil {
				return mcp.Errorf(mcp.CodeInvalid, "%v", err)
			}
			return nil
		}
		if _, err := validate.RestartableUnit(in.Unit); err != nil {
			return mcp.Errorf(mcp.CodeInvalid, "%v", err)
		}
		return nil
	},
	"apps.set_default": func(raw json.RawMessage) error {
		var in struct {
			MimeType string `json:"mimeType"`
			AppID    string `json:"appId"`
		}
		if err := mcp.DecodeArgs(raw, &in); err != nil {
			return err
		}
		if len(in.MimeType) < 3 || len(in.MimeType) > 255 || in.AppID == "" || len(in.AppID) > 255 {
			return mcp.Errorf(mcp.CodeInvalid, "mimeType and appId are required")
		}
		return nil
	},
	"note": func(raw json.RawMessage) error {
		var in struct{}
		return mcp.DecodeArgs(raw, &in)
	},
}

// CheckRecipe refuses a recipe with a step outside the allowlist or with
// input that step's tool would refuse. One bad step refuses the recipe.
func CheckRecipe(r recipes.Recipe) error {
	for i, s := range r.Steps {
		check, ok := recipeSteps[s.Tool]
		if !ok {
			return fmt.Errorf("recipe %s step %d uses %s, which recipes may not use", r.ID, i+1, s.Tool)
		}
		if err := check(s.Input); err != nil {
			return fmt.Errorf("recipe %s step %d: %s", r.ID, i+1, mcp.AsToolError(err).Message)
		}
	}
	return nil
}

func (d Deps) recipeTools() []mcp.Tool {
	return []mcp.Tool{{
		Name: "recipes.list",
		Description: "List this computer's setup recipes (for example \"set up for Python\"): curated, reviewed plans of several steps. " +
			"Each has an id, a digest, its steps (index, tool, title) and whether it can run here.",
		InputSchema: mcp.EmptySchema,
		Risk:        mcp.RiskSafe,
		Call:        d.listRecipes,
	}}
}

type recipeStepView struct {
	Index int          `json:"index"`
	Tool  string       `json:"tool"`
	Title recipes.Text `json:"title"`
}

type recipeView struct {
	ID          string           `json:"id"`
	Digest      string           `json:"digest"`
	Title       recipes.Text     `json:"title"`
	Description recipes.Text     `json:"description"`
	Steps       []recipeStepView `json:"steps"`
	Available   bool             `json:"available"`
	Reason      string           `json:"reason,omitempty"`
}

func (d Deps) listRecipes(_ context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	views, probs := []recipeView{}, []recipes.Problem{}
	if d.Recipes == nil {
		return map[string]any{"recipes": views, "skipped": probs}, nil
	}
	list, skipped, err := d.Recipes.List()
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "%v", err)
	}
	probs = append(probs, skipped...)
	var host recipes.Host
	if d.FS != nil {
		host = recipes.ReadHost(d.FS)
	}
	for _, r := range list {
		if err := CheckRecipe(r); err != nil {
			probs = append(probs, recipes.Problem{File: r.ID + ".json", Reason: err.Error()})
			continue
		}
		v := recipeView{ID: r.ID, Digest: r.Digest, Title: r.Title, Description: r.Description, Steps: []recipeStepView{}}
		for i, s := range r.Steps {
			v.Steps = append(v.Steps, recipeStepView{Index: i, Tool: s.Tool, Title: s.Title})
		}
		switch {
		case !r.IsAvailable():
			v.Reason = "this recipe cannot run yet: it needs a download that is not hosted yet"
		default:
			v.Available, v.Reason = r.Fits(host)
		}
		views = append(views, v)
	}
	return map[string]any{"recipes": views, "skipped": probs}, nil
}
