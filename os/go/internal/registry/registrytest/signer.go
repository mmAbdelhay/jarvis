// Package registrytest makes throwaway OpenPGP keys and detached
// signatures for tests. Keys live only in memory and die with the test;
// this package must never be used to make a real signing key.
package registrytest

import (
	"bytes"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

// Signer is one throwaway Ed25519 key.
type Signer struct {
	t testing.TB
	e *openpgp.Entity
}

// NewSigner makes a fresh key.
func NewSigner(t testing.TB) *Signer {
	t.Helper()
	e, err := openpgp.NewEntity("Throwaway Test Key", "tests only", "test@invalid.example",
		&packet.Config{Algorithm: packet.PubKeyAlgoEdDSA})
	if err != nil {
		t.Fatal(err)
	}
	return &Signer{t: t, e: e}
}

// Keyring is the public key as a binary keyring (like a .gpg file).
func (s *Signer) Keyring() []byte {
	var b bytes.Buffer
	if err := s.e.Serialize(&b); err != nil {
		s.t.Fatal(err)
	}
	return b.Bytes()
}

// ArmoredKeyring is the public key ASCII-armoured (like a .asc file).
func (s *Signer) ArmoredKeyring() []byte {
	var b bytes.Buffer
	w, err := armor.Encode(&b, openpgp.PublicKeyType, nil)
	if err != nil {
		s.t.Fatal(err)
	}
	if err := s.e.Serialize(w); err != nil {
		s.t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		s.t.Fatal(err)
	}
	return b.Bytes()
}

// Sign returns a binary detached signature of data.
func (s *Signer) Sign(data []byte) []byte {
	var b bytes.Buffer
	if err := openpgp.DetachSign(&b, s.e, bytes.NewReader(data), nil); err != nil {
		s.t.Fatal(err)
	}
	return b.Bytes()
}

// ArmoredSign returns an ASCII-armoured detached signature of data.
func (s *Signer) ArmoredSign(data []byte) []byte {
	var b bytes.Buffer
	if err := openpgp.ArmoredDetachSign(&b, s.e, bytes.NewReader(data), nil); err != nil {
		s.t.Fatal(err)
	}
	return b.Bytes()
}
