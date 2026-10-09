package pkgtools

import (
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
)

// Both card tables are complete in both languages (Rafiq M4 contracts §3).
func TestCardTablesAreComplete(t *testing.T) {
	for _, p := range i18n.Check(cardText.Get(i18n.EN), cardText.Get(i18n.AR)) {
		t.Errorf("cardText.%s", p)
	}
	for _, p := range i18n.Check(registryText.Get(i18n.EN), registryText.Get(i18n.AR)) {
		t.Errorf("registryText.%s", p)
	}
}
