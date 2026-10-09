package files

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOSUnderRoot(t *testing.T) {
	root := t.TempDir()
	o := &OS{Root: root, RecordChown: true}
	if err := o.MkdirAll("/target/etc", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := o.WriteFile("/target/etc/hostname", []byte("ada-laptop\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(root, "target/etc/hostname"))
	if err != nil || string(b) != "ada-laptop\n" {
		t.Fatalf("read back %q, %v", b, err)
	}
	if st, _ := os.Stat(filepath.Join(root, "target/etc/hostname")); st.Mode().Perm() != 0o644 {
		t.Fatalf("mode = %v", st.Mode())
	}
	// Overwrite keeps no temp files behind.
	if err := o.WriteFile("/target/etc/hostname", []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if m, _ := o.Glob("/target/etc/*"); !reflect.DeepEqual(m, []string{"/target/etc/hostname"}) {
		t.Fatalf("glob = %v", m)
	}
	if err := o.Chown("/target/etc/hostname", 1000, 1000); err != nil {
		t.Fatal(err)
	}
	if err := o.Chown("/target/nope", 1, 1); err == nil {
		t.Fatal("chown of a missing file must fail even when recording")
	}
	if got := o.Chowned(); !reflect.DeepEqual(got, []string{"/target/etc/hostname 1000:1000"}) {
		t.Fatalf("chowned = %v", got)
	}
	if err := o.Symlink("/usr/share/zoneinfo/Africa/Cairo", "/target/etc/localtime"); err != nil {
		t.Fatal(err)
	}
	if l, _ := os.Readlink(filepath.Join(root, "target/etc/localtime")); l != "/usr/share/zoneinfo/Africa/Cairo" {
		t.Fatalf("link = %q", l)
	}
	if h, err := o.ReadHead("/target/etc/hostname", 64); err != nil || string(h) != "x\n" {
		t.Fatalf("head = %q, %v", h, err)
	}
	if !o.Exists("/target/etc/localtime") || o.Exists("/target/nope") {
		t.Fatal("Exists wrong")
	}
	if err := o.Remove("/target/nope"); err != nil {
		t.Fatalf("removing a missing file is not an error: %v", err)
	}
}
