package install

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// packagedGreetd is jarvis-greeter's /etc/greetd/config.toml (Plan H).
const packagedGreetd = "[terminal]\nvt = 7\n\n[default_session]\ncommand = \"/usr/lib/jarvis-greeter/with-keyboard cage -s -- jarvis-greeter\"\nuser = \"_greetd\"\n"

func TestGreetdAutologinEditsOnlyTheInitialSession(t *testing.T) {
	live := packagedGreetd + "\n[initial_session]\ncommand = \"labwc\"\nuser = \"user\"\n"
	if got := greetdAutologin(live, "ada", false); got != packagedGreetd {
		t.Fatalf("the live autologin must not survive: %q", got)
	}
	if got := greetdAutologin(packagedGreetd, "ada", false); got != packagedGreetd {
		t.Fatal("a config without autologin stays byte for byte")
	}
	want := packagedGreetd + "\n[initial_session]\ncommand = \"labwc\"\nuser = \"ada\"\n"
	if got := greetdAutologin(live, "ada", true); got != want {
		t.Fatalf("got %q", got)
	}
}

func TestRenderers(t *testing.T) {
	if got := renderCrypttab("u-1"); !strings.HasSuffix(got, "jarvis-root UUID=u-1 none luks,discard,initramfs,tries=0\n") {
		t.Fatalf("crypttab = %q (tries=0: never an emergency shell)", got)
	}
	if got := renderFstab("r", "e", "s"); got != "# /etc/fstab: written by the Rafiq installer.\nUUID=r / ext4 errors=remount-ro 0 1\nUUID=e /boot/efi vfat umask=0077 0 1\nUUID=s none swap sw 0 0\n/swapfile none swap sw 0 0\n" {
		t.Fatalf("fstab = %q", got)
	}
	if got := renderKeyboard("us(intl)"); !strings.Contains(got, "XKBLAYOUT=\"us\"\nXKBVARIANT=\"intl\"\n") {
		t.Fatalf("keyboard = %q", got)
	}
	if got := renderLocaleGen("ar_EG.UTF-8"); got != "ar_EG.UTF-8 UTF-8\nen_US.UTF-8 UTF-8\n" {
		t.Fatalf("locale.gen = %q", got)
	}
	if got := renderGrub(true); !strings.Contains(got, "GRUB_TIMEOUT=3\nGRUB_TIMEOUT_STYLE=menu\n") || !strings.Contains(got, "GRUB_DISABLE_OS_PROBER=false") {
		t.Fatalf("grub = %q", got)
	}
	if got := renderJarvisYAML("openai-compatible", "http://10.0.0.5:8000/v1", "qwen: \"x\""); !strings.Contains(got, "  model: \"qwen: \\\"x\\\"\"\n") {
		t.Fatalf("yaml quoting = %q", got)
	}
}

func TestLoggerRedactsSecretsAndTokens(t *testing.T) {
	var out bytes.Buffer
	l := NewLogger(&out, func() time.Time { return time.Date(2026, 10, 8, 9, 30, 0, 0, time.UTC) })
	l.AddSecret("correct horse battery staple")
	l.AddSecret("abc") // too short to search for safely
	l.Printf("stderr: No key available with this passphrase: correct horse battery staple")
	l.Printf("apt: Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz\nsecond line abc")
	got := out.String()
	want := "09:30:00 stderr: No key available with this passphrase: [redacted:secret]\n" +
		"09:30:00 apt: Authorization: [redacted:authorization]\n" +
		"09:30:00 second line abc\n"
	if got != want || string(l.Bytes()) != want {
		t.Fatalf("log\n got %q\nwant %q", got, want)
	}
	if tail := l.Tail(2); len(tail) != 2 || tail[1] != "second line abc" {
		t.Fatalf("tail = %q", tail)
	}
}

func TestGreetdPreservesUnrelatedBytes(t *testing.T) {
	for _, conf := range []string{"", packagedGreetd + "\n\n", "# config without final newline", packagedGreetd + "\n[initial_session]\nuser = \"live\"\n\n[extra]\nvalue = 1\n\n"} {
		want := conf
		if strings.Contains(conf, "[initial_session]") {
			want = packagedGreetd + "\n[extra]\nvalue = 1\n\n"
		}
		if got := greetdAutologin(conf, "ada", false); got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
}

func TestLoggerSecretThreshold(t *testing.T) {
	l := NewLogger(nil, nil)
	l.AddSecret("xyz")
	l.AddSecret("wxyz")
	l.AddSecret("abcdefg")
	l.AddSecret("ijklmnop")
	l.Printf("xyz wxyz abcdefg ijklmnop")
	if got := l.Tail(1); len(got) != 1 || got[0] != "xyz [redacted:secret] [redacted:secret] [redacted:secret]" {
		t.Fatalf("tail = %q", got)
	}
}

func TestRenderGrubDistro(t *testing.T) {
	if got := renderGrub(false); !strings.Contains(got, "GRUB_DISTRIBUTOR=\"Rafiq\"\n") {
		t.Fatalf("grub = %q", got)
	}
}
