package install

import (
	"context"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
)

// M4 contracts §6.6: an Arabic install (Choices.locale ar_*) gets its
// summary, warnings, step titles, refusals and progress text in Arabic, and
// the new user's jarvis.yaml says os.language: ar.

func arabicChoices(mode, disk string) Choices {
	c := choices(mode, disk)
	c.Locale = "ar_EG.UTF-8"
	return c
}

func TestPlanLanguageFollowsTheLocale(t *testing.T) {
	for locale, want := range map[string]i18n.Lang{"ar_EG.UTF-8": i18n.AR, "ar_SA.UTF-8": i18n.AR, "en_US.UTF-8": i18n.EN, "de_DE.UTF-8": i18n.EN} {
		if got := langOf(Choices{Locale: locale}); got != want {
			t.Errorf("%s: %s, want %s", locale, got, want)
		}
	}
}

func TestPlanInArabic(t *testing.T) {
	pl, err := MakePlan(arabicChoices("erase", "/dev/nvme0n1"), probe(emptyDisk()), "p1")
	if err != nil {
		t.Fatal(err)
	}
	s := pl.Public.Summary
	if len(s) != 8 || !strings.HasPrefix(s[0], i18n.RLM+"مسح القرص") || !strings.Contains(s[1], "مشفّرًا") || !strings.Contains(s[6], "جارفيس") {
		t.Fatalf("summary = %q", s)
	}
	for _, line := range append(append([]string{}, s...), pl.Public.Warnings...) {
		if latin := i18n.LatinOutsideIsolates(line); latin != "" {
			t.Errorf("Latin %q outside an isolate in %q", latin, line)
		}
	}
	if pl.Public.Steps[0].Title != "تجهيز القرص" || pl.Public.Steps[len(pl.Public.Steps)-1].Title != "تنزيل عقل جارفيس" {
		t.Fatalf("steps = %+v", pl.Public.Steps)
	}
	if pl.Public.DiskAfter[1].Label != "رفيق" {
		t.Fatalf("diskAfter = %+v", pl.Public.DiskAfter)
	}
	if !strings.Contains(pl.Public.Warnings[0], "تثبيت") {
		t.Fatalf("warnings = %q", pl.Public.Warnings)
	}
	// English stays exactly as it was.
	en, _ := MakePlan(choices("erase", "/dev/nvme0n1"), probe(emptyDisk()), "p1")
	if en.Public.Steps[0].Title != "Prepare the disk" {
		t.Fatalf("english steps = %+v", en.Public.Steps)
	}
}

func TestRefusalInArabic(t *testing.T) {
	p := probe(emptyDisk())
	p.UEFI = false
	_, err := MakePlan(arabicChoices("erase", "/dev/nvme0n1"), p, "p1")
	if refusal(t, err) != RefuseNoUEFI || !strings.Contains(err.Error(), "يحتاج رفيق") {
		t.Fatalf("refusal = %v", err)
	}
	small := emptyDisk()
	small.SizeBytes, small.LastUsable = 17179869184, 33554398
	_, err = MakePlan(arabicChoices("erase", "/dev/nvme0n1"), probe(small), "p1")
	if refusal(t, err) != RefuseDiskTooSmall || !strings.Contains(err.Error(), "صغير جدًا") {
		t.Fatalf("refusal = %v", err)
	}
}

func TestExecuteCancelInArabic(t *testing.T) {
	h := newHarness(t, false)
	h.run.on(execx.OK(nvmeSgdisk), "sgdisk", "-p", "/dev/nvme0n1")
	g := &Gate{}
	g.Cancel()
	pl, err := MakePlan(arabicChoices("erase", "/dev/nvme0n1"), probe(emptyDisk()), "plan-1")
	if err != nil {
		t.Fatal(err)
	}
	Execute(context.Background(), h.deps, pl, secrets(), g)
	if h.ev.finished[0] != "false||"+texts.Get(i18n.AR).Cancelled || !strings.Contains(h.ev.finished[0], "أُلغي") {
		t.Fatalf("finished %v", h.ev.finished)
	}
}

func TestBrainConfigWritesTheLanguage(t *testing.T) {
	for _, tc := range []struct {
		name, locale, kind, want string
	}{
		{"arabic local", "ar_EG.UTF-8", "local", "# Written by the Rafiq installer. Change it in Settings.\nprovider:\n  kind: ollama\n  baseUrl: \"http://127.0.0.1:11434\"\n  model: \"qwen3:4b\"\nos:\n  language: ar\n"},
		{"arabic cloud", "ar_EG.UTF-8", "cloud", "# Written by the Rafiq installer. Change it in Settings.\nos:\n  language: ar\n"},
		{"english local", "en_US.UTF-8", "local", "# Written by the Rafiq installer. Change it in Settings.\nprovider:\n  kind: ollama\n  baseUrl: \"http://127.0.0.1:11434\"\n  model: \"qwen3:4b\"\n"},
		{"english cloud", "en_US.UTF-8", "cloud", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, false)
			c := choices("erase", "/dev/nvme0n1")
			c.Locale = tc.locale
			c.Brain.Kind = tc.kind
			if tc.kind == "cloud" {
				c.Brain.ModelID = ""
			}
			pl, err := MakePlan(c, probe(emptyDisk()), "p")
			if err != nil {
				t.Fatal(err)
			}
			j := &job{d: h.deps, pl: pl, x: trFor(pl.Choices), user: parse.PasswdEntry{Name: "ada", UID: 1000, GID: 1000, Home: "/home/ada"}}
			if err := j.brainConfig(context.Background()); err != nil {
				t.Fatal(err)
			}
			const file = "/target/home/ada/.config/jarvis/jarvis.yaml"
			if tc.want == "" {
				if h.fs.Exists(file) {
					t.Fatalf("%s written for an English cloud brain", file)
				}
				return
			}
			if got := h.read(t, file); got != tc.want {
				t.Fatalf("jarvis.yaml\n got %q\nwant %q", got, tc.want)
			}
		})
	}
}
