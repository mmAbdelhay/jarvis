package parse

import (
	"os"
	"path/filepath"
	"testing"
)

// fixture reads testdata/<name> (see testdata/CAPTURE.md for its source command).
func fixture(t *testing.T, name string) string {
	return string(fixtureBytes(t, name))
}

func fixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
