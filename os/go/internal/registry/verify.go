package registry

import (
	"bytes"
	"errors"
	"fmt"
	"os"

	"github.com/ProtonMail/go-crypto/openpgp"
)

// KeyringPath is the Jarvis archive keyring (package jarvis-archive-keyring,
// M2 contracts §7); the same key signs the APT repo and the registry index.
const KeyringPath = "/usr/share/keyrings/jarvis-archive-keyring.gpg"

// MaxSignatureBytes bounds index.json.sig.
const MaxSignatureBytes = 64 << 10

// ErrBadSignature wraps every signature failure.
var ErrBadSignature = errors.New("registry: the index signature does not verify against the Jarvis archive key")

// Keyring is the set of public keys an index signature must come from.
type Keyring struct {
	entities openpgp.EntityList
}

func armored(b []byte) bool {
	return bytes.HasPrefix(bytes.TrimSpace(b), []byte("-----BEGIN PGP"))
}

// LoadKeyring reads a binary or ASCII-armoured public keyring.
func LoadKeyring(b []byte) (k *Keyring, err error) {
	defer func() {
		if r := recover(); r != nil {
			k, err = nil, fmt.Errorf("registry: the archive keyring is damaged")
		}
	}()
	var list openpgp.EntityList
	if armored(b) {
		list, err = openpgp.ReadArmoredKeyRing(bytes.NewReader(b))
	} else {
		list, err = openpgp.ReadKeyRing(bytes.NewReader(b))
	}
	if err != nil {
		return nil, fmt.Errorf("registry: reading the archive keyring: %w", err)
	}
	if len(list) == 0 {
		return nil, errors.New("registry: the archive keyring holds no keys")
	}
	return &Keyring{entities: list}, nil
}

// ReadKeyring loads the keyring file at path.
func ReadKeyring(path string) (*Keyring, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("registry: cannot read the archive keyring (%w); is jarvis-archive-keyring installed?", err)
	}
	return LoadKeyring(b)
}

// Verify checks a detached signature (binary or armoured) of data. The
// signature must come from a key in k; expired or revoked keys fail.
func (k *Keyring) Verify(data, sig []byte) (err error) {
	if k == nil || len(k.entities) == 0 || len(sig) == 0 || len(sig) > MaxSignatureBytes {
		return ErrBadSignature
	}
	defer func() {
		if r := recover(); r != nil {
			err = ErrBadSignature
		}
	}()
	if armored(sig) {
		_, err = openpgp.CheckArmoredDetachedSignature(k.entities, bytes.NewReader(data), bytes.NewReader(sig), nil)
	} else {
		_, err = openpgp.CheckDetachedSignature(k.entities, bytes.NewReader(data), bytes.NewReader(sig), nil)
	}
	if err != nil {
		return fmt.Errorf("%w (%v)", ErrBadSignature, err)
	}
	return nil
}
