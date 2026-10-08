package registry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// DefaultIndexURL is where Plan L publishes the signed index (contracts §3).
const DefaultIndexURL = "https://mmabdelhay.github.io/jarvis-apt/registry/index.json"

const fetchTimeout = 20 * time.Second

// ErrOffline means the registry could not be reached and there is no
// verified cached copy to fall back on.
var ErrOffline = errors.New("registry: the registry could not be reached and no verified copy is saved")

// Source fetches the signed index and keeps the last verified copy.
type Source struct {
	IndexURL string
	Client   *http.Client
	// Keyring is called on every Load, so a keyring package installed
	// while jarvis-pkg runs is picked up.
	Keyring  func() (*Keyring, error)
	CacheDir string           // ~/.cache/jarvis/registry; "" disables the cache
	Now      func() time.Time // nil = time.Now (tests)
}

// ErrExpired means a signed index is past its validUntil (contracts §7.6).
var ErrExpired = errors.New("registry: the index is past its validUntil")

func (s *Source) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// NewHTTPClient is the client for the index and artifacts: https only,
// even after a redirect, and at most 5 redirects.
func NewHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Minute, // a 64 MiB artifact on a slow link
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "https" {
				return errors.New("redirect to a non-https address refused")
			}
			return nil
		},
	}
}

func httpsURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("registry: %q is not an https address", raw)
	}
	return u, nil
}

// get fetches an https URL into memory, refusing bodies over max bytes.
func get(ctx context.Context, c *http.Client, raw string, max int64) ([]byte, error) {
	u, err := httpsURL(raw)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "jarvis-pkg")
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: %s answered %s", ErrNetwork, u.Host, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("registry: %s is larger than %d bytes", u.Path, max)
	}
	return b, nil
}

// Load returns the newest verified index. Order of trust:
//  1. fetch index.json and index.json.sig; a signature failure is an
//     error even when a good cache exists (a tampered registry is news);
//  2. on a network failure (including a missing .sig) fall back to the
//     cache, re-verified; nothing verified → ErrOffline;
//  3. a fetched index older than the cached one is ignored (no rollback).
//
// persist=false never writes (jarvis.describe must be side-effect free).
func (s *Source) Load(ctx context.Context, persist bool) (*Index, error) {
	kr, err := s.Keyring()
	if err != nil {
		return nil, err
	}
	cached, cacheErr := s.cached(kr)
	if cacheErr == nil && !s.now().Before(cached.Expiry()) {
		cached, cacheErr = nil, ErrExpired
	}

	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	data, err := get(ctx, s.Client, s.IndexURL, MaxIndexBytes)
	var sig []byte
	if err == nil {
		sig, err = get(ctx, s.Client, s.IndexURL+".sig", MaxSignatureBytes)
	}
	if err != nil {
		if !errors.Is(err, ErrNetwork) {
			return nil, err
		}
		if cacheErr == nil {
			return cached, nil
		}
		return nil, fmt.Errorf("%w (%v)", ErrOffline, err)
	}
	if err := kr.Verify(data, sig); err != nil {
		return nil, err
	}
	ix, err := ParseIndex(data)
	if err != nil {
		return nil, err
	}
	if !s.now().Before(ix.Expiry()) {
		return nil, ErrExpired
	}
	if cacheErr == nil && ix.Generated().Before(cached.Generated()) {
		return cached, nil
	}
	if persist {
		// A cache that cannot be written only costs offline use.
		_ = s.store(data, sig)
	}
	return ix, nil
}

// Cached returns the cached index after verifying it again.
func (s *Source) Cached() (*Index, error) {
	kr, err := s.Keyring()
	if err != nil {
		return nil, err
	}
	ix, err := s.cached(kr)
	if err == nil && !s.now().Before(ix.Expiry()) {
		return nil, ErrExpired
	}
	return ix, err
}

func (s *Source) cached(kr *Keyring) (*Index, error) {
	if s.CacheDir == "" {
		return nil, os.ErrNotExist
	}
	data, err := readCapped(filepath.Join(s.CacheDir, "index.verified.json"), MaxIndexBytes)
	if err != nil {
		return nil, err
	}
	sig, err := readCapped(filepath.Join(s.CacheDir, "index.verified.json.sig"), MaxSignatureBytes)
	if err != nil {
		return nil, err
	}
	if err := kr.Verify(data, sig); err != nil {
		return nil, err
	}
	return ParseIndex(data)
}

func readCapped(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, invalid("%s is larger than %d bytes", path, max)
	}
	return b, nil
}

func (s *Source) store(data, sig []byte) error {
	if s.CacheDir == "" {
		return nil
	}
	if err := os.MkdirAll(s.CacheDir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(s.CacheDir, 0o700); err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(s.CacheDir, "index.verified.json"), data, 0o600); err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.CacheDir, "index.verified.json.sig"), sig, 0o600)
}
