package diagtools

import (
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// Both languages complete, and a consequence line for every unit the
// helper may restart, in both languages.
func TestCardTextIsComplete(t *testing.T) {
	for _, p := range i18n.Check(cardText.Get(i18n.EN), cardText.Get(i18n.AR)) {
		t.Errorf("cardText.%s", p)
	}
	for _, l := range []i18n.Lang{i18n.EN, i18n.AR} {
		for _, u := range validate.RestartAllowlist {
			if cardText.Get(l).RestartEffect[u] == "" {
				t.Errorf("%s: no restart consequence for allowlisted unit %s", l, u)
			}
		}
	}
}
