package registry

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	MaxArtifactBytes = 64 << 20
	MaxUnpackedBytes = 256 << 20
	MaxFiles         = 2000
)

// ErrChecksum means the bytes downloaded are not the ones the signed
// index pinned. Nothing from such a download is ever kept.
var ErrChecksum = errors.New("registry: the download does not match the checksum in the signed registry")

// EntryPoint is the file jarvisd starts for a runtime (contracts §3).
func EntryPoint(rt Runtime) string {
	switch rt {
	case RuntimeNode:
		return "server.js"
	case RuntimePython:
		return "server.py"
	default:
		return "server"
	}
}

// Download streams an https URL into dst and checks its SHA-256.
func Download(ctx context.Context, c *http.Client, rawURL, sha256hex string, dst io.Writer) error {
	return download(ctx, c, rawURL, sha256hex, dst, MaxArtifactBytes)
}

func download(ctx context.Context, c *http.Client, rawURL, want string, dst io.Writer, max int64) error {
	u, err := httpsURL(rawURL)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "jarvis-pkg")
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: %s answered %s", ErrNetwork, u.Host, resp.Status)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, h), io.LimitReader(resp.Body, max+1))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	if n > max {
		return fmt.Errorf("registry: the download is larger than %d bytes", max)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("%w (got %s)", ErrChecksum, got)
	}
	return nil
}

type limits struct {
	bytes int64
	files int
}

// Unpack extracts a gzip tar into dir, which must exist and be empty.
// Only regular files and folders are accepted; names must stay inside
// dir; sizes and counts are capped; files are created O_EXCL|O_NOFOLLOW
// with mode 0755 (any execute bit) or 0644.
func Unpack(r io.Reader, dir string) error {
	return unpack(r, dir, limits{bytes: MaxUnpackedBytes, files: MaxFiles})
}

func unpack(r io.Reader, dir string, lim limits) error {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return invalid("the artifact is not a gzip file: %v", err)
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	var total int64
	files := 0
	seen := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return invalid("the artifact is not a tar archive: %v", err)
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue // pax global header (git archive writes one)
		}
		name, err := safeName(h.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue // "./"
		}
		if seen[name] {
			return invalid("the artifact lists %q twice", name)
		}
		seen[name] = true
		files++
		if files > lim.files {
			return invalid("the artifact has more than %d entries", lim.files)
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if h.Size < 0 || total+h.Size > lim.bytes {
				return invalid("the artifact unpacks to more than %d bytes", lim.bytes)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				mode = 0o755
			}
			f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
			if err != nil {
				return invalid("the artifact entry %q cannot be created: %v", name, err)
			}
			n, err := io.Copy(f, io.LimitReader(tr, h.Size))
			cerr := f.Close()
			if err != nil {
				return invalid("the artifact entry %q is damaged: %v", name, err)
			}
			if cerr != nil {
				return cerr
			}
			if n != h.Size {
				return invalid("the artifact entry %q is truncated", name)
			}
			total += n
			if err := os.Chmod(target, mode); err != nil { // umask may have cut bits
				return err
			}
		default:
			return invalid("the artifact entry %q is a link or device; only files and folders are allowed", name)
		}
	}
}

// safeName returns the cleaned slash path of a tar entry, "" for the
// archive root, or ErrInvalid for anything that could leave the folder.
func safeName(n string) (string, error) {
	if n == "" || strings.HasPrefix(n, "/") || strings.ContainsAny(n, "\\\x00") {
		return "", invalid("the artifact entry %q has an absolute or odd name", n)
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return "", invalid("the artifact entry %q leaves its folder", n)
		}
	}
	clean := path.Clean(n)
	if clean == "." {
		return "", nil
	}
	return clean, nil
}

// PackFile is one regular file for Pack.
type PackFile struct {
	Name string // slash path inside the archive, already clean
	Mode int64  // only the permission bits are kept
	Data []byte
}

// Pack writes a deterministic gzip tar: names sorted, mtime 0, uid/gid 0,
// no user names, USTAR format, so the same inputs give the same SHA-256.
func Pack(w io.Writer, files []PackFile) error {
	sorted := append([]PackFile(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	zw, err := gzip.NewWriterLevel(w, gzip.BestCompression)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(zw)
	for _, f := range sorted {
		if clean, err := safeName(f.Name); err != nil || clean != f.Name {
			return invalid("pack: bad name %q", f.Name)
		}
		h := &tar.Header{
			Typeflag: tar.TypeReg, Name: f.Name, Mode: f.Mode & 0o777,
			Size: int64(len(f.Data)), ModTime: time.Unix(0, 0), Format: tar.FormatUSTAR,
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if _, err := tw.Write(f.Data); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return zw.Close()
}
