package diagtools

import (
	"reflect"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// Guards the translation table: no empty string, and a consequence line for
// every unit the helper may restart.
func TestCardTextIsComplete(t *testing.T) {
	v := reflect.ValueOf(cardText)
	for i := 0; i < v.NumField(); i++ {
		if f := v.Field(i); f.Kind() == reflect.String && f.String() == "" {
			t.Errorf("cardText.%s is empty", v.Type().Field(i).Name)
		}
	}
	for _, u := range validate.RestartAllowlist {
		if cardText.RestartEffect[u] == "" {
			t.Errorf("no restart consequence for allowlisted unit %s", u)
		}
	}
}
