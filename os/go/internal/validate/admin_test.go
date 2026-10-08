package validate

import (
	"errors"
	"testing"
)

func TestUsername(t *testing.T) {
	for _, ok := range []string{"sara", "omar_1", "a", "_x", "user-name"} {
		if err := Username(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "Sara", "1abc", "-x", "a b", "root", "nobody", "systemd-network", "x-", "abcdefghijklmnopqrstuvwxyz0123456", "omar\n", "../x"} {
		if err := Username(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q must be invalid: %v", bad, err)
		}
	}
}

func TestFullName(t *testing.T) {
	for _, ok := range []string{"", "Sara Ahmed", "سارة أحمد"} {
		if err := FullName(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"a:b", "a,b", "a=b", `a\b`, "-x", "a\nb", "a‮b", string(make([]rune, 65))} {
		if err := FullName(bad); err == nil {
			t.Errorf("%q must be invalid", bad)
		}
	}
}

func TestWholeDiskAndLabels(t *testing.T) {
	for _, ok := range []string{"/dev/sdb", "/dev/sdaa", "/dev/mmcblk0"} {
		if err := WholeDisk(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"/dev/sdb1", "/dev/nvme0n1", "/dev/mmcblk0p1", "/dev/loop0", "/dev/../sda", "sdb", "/dev/sdb "} {
		if err := WholeDisk(bad); err == nil {
			t.Errorf("%q must be invalid", bad)
		}
	}
	for _, c := range []struct{ fs, in, want string }{{"vfat", "photos", "PHOTOS"}, {"exfat", "My USB", "My USB"}, {"ext4", "", ""}} {
		if got, err := FSLabel(c.fs, c.in); err != nil || got != c.want {
			t.Errorf("%v: %q %v", c, got, err)
		}
	}
	for _, c := range []struct{ fs, in string }{{"ntfs", "x"}, {"vfat", "TWELVE CHARS"}, {"exfat", "-x"}, {"ext4", "a/b"}, {"ext4", "seventeen chars!!"}} {
		if _, err := FSLabel(c.fs, c.in); err == nil {
			t.Errorf("%v must be invalid", c)
		}
	}
}

func TestPassword(t *testing.T) {
	for _, ok := range []string{"x", "pässword with spaces:colon"} {
		if err := Password(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a\nb", "a\rb", "a\x00b", string(make([]byte, 129))} {
		if err := Password(bad); err == nil {
			t.Errorf("%q must be invalid", bad)
		}
	}
}
