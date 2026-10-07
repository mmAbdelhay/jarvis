package validate

import (
	"errors"
	"fmt"
	"testing"
)

func TestUpgradeBatchesAllow200(t *testing.T) {
	names := make([]string, 200)
	refs := make([]string, 200)
	for i := range names {
		names[i] = fmt.Sprintf("pkg%d", i)
		refs[i] = fmt.Sprintf("org.example.App%d", i)
	}
	if err := AptUpgradeNames(names); err != nil {
		t.Fatalf("200 apt names: %v", err)
	}
	if err := FlatpakUpdateRefs(refs); err != nil {
		t.Fatalf("200 refs: %v", err)
	}
	if err := AptUpgradeNames(append(names, "one-more")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("201 names: %v", err)
	}
	if err := AptUpgradeNames(nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("0 names: %v", err)
	}
	if err := AptNames(names[:11]); !errors.Is(err, ErrInvalid) {
		t.Fatalf("install batches stay at 10: %v", err)
	}
	if err := FlatpakUpdateRefs([]string{"org.example.App", "--from"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("hostile ref: %v", err)
	}
}
