package registry

import "testing"

// The Rafiq M3 built-in servers are trusted by name like jarvis-pkg, so no
// registry entry may take their ids (Rafiq M3 contracts §1).
func TestM3BuiltInIDsAreReserved(t *testing.T) {
	for _, id := range []string{"jarvis-settings", "jarvis-apps", "jarvis-wl"} {
		if err := ValidID(id); err == nil {
			t.Errorf("%s must be reserved", id)
		}
	}
	if err := ValidID("jarvis-files"); err != nil {
		t.Errorf("jarvis-files stays an official registry id: %v", err)
	}
}
