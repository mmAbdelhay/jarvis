package registry

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/registry/registrytest"
)

func TestVerifyAcceptsBinaryAndArmoredForms(t *testing.T) {
	s := registrytest.NewSigner(t)
	data := []byte(`{"version":1,"generatedAt":"2026-10-09T08:00:00Z","entries":[]}`)
	for kname, kr := range map[string][]byte{"binary": s.Keyring(), "armored": s.ArmoredKeyring()} {
		k, err := LoadKeyring(kr)
		if err != nil {
			t.Fatalf("%s keyring: %v", kname, err)
		}
		for sname, sig := range map[string][]byte{"binary": s.Sign(data), "armored": s.ArmoredSign(data)} {
			if err := k.Verify(data, sig); err != nil {
				t.Errorf("%s keyring, %s signature: %v", kname, sname, err)
			}
		}
	}
}

func TestVerifyRefuses(t *testing.T) {
	s := registrytest.NewSigner(t)
	other := registrytest.NewSigner(t)
	k, err := LoadKeyring(s.Keyring())
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"version":1}`)
	tampered := bytes.Clone(data)
	tampered[len(tampered)-2] = '2'
	cases := map[string][2][]byte{
		"tampered data":   {tampered, s.Sign(data)},
		"other key":       {data, other.Sign(data)},
		"garbage":         {data, []byte("not a signature")},
		"armored garbage": {data, []byte("-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n")},
		"empty":           {data, nil},
		"huge":            {data, bytes.Repeat([]byte{0x89}, MaxSignatureBytes+1)},
	}
	for name, c := range cases {
		if err := k.Verify(c[0], c[1]); !errors.Is(err, ErrBadSignature) {
			t.Errorf("%s: err = %v, want ErrBadSignature", name, err)
		}
	}
	var none *Keyring
	if err := none.Verify(data, s.Sign(data)); !errors.Is(err, ErrBadSignature) {
		t.Errorf("nil keyring: %v", err)
	}
}

func TestLoadKeyringRefusesEmptyAndMissing(t *testing.T) {
	if _, err := LoadKeyring(nil); err == nil {
		t.Fatal("an empty keyring must be refused")
	}
	_, err := ReadKeyring(filepath.Join(t.TempDir(), "none.gpg"))
	if err == nil || !strings.Contains(err.Error(), "jarvis-archive-keyring") {
		t.Fatalf("missing keyring: %v", err)
	}
}
