package pkgtools

import (
	"reflect"
	"testing"
)

// Guards the translation table: a field left empty would put a blank line
// on a card, and the M4 Arabic pass needs every string in one place.
func TestCardTextHasNoEmptyStrings(t *testing.T) {
	v := reflect.ValueOf(cardText)
	for i := 0; i < v.NumField(); i++ {
		if v.Field(i).String() == "" {
			t.Errorf("cardText.%s is empty", v.Type().Field(i).Name)
		}
	}
}
