// Package guard holds jarvis-cu's checks that run before every input:
// is the screen locked, and does an AT-SPI password field have focus
// (Rafiq v1.1 contracts §1; design §2.4, §2.9).
package guard

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LockWatch detects the lock screen by its running program.
type LockWatch struct {
	ProcRoot string
	Exes     []string
}

// DefaultLockWatch watches /proc for the given lock programs.
func DefaultLockWatch(exes []string) LockWatch {
	return LockWatch{ProcRoot: "/proc", Exes: exes}
}

func isPID(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Locked reports whether a lock-screen program runs. It fails closed.
func (l LockWatch) Locked() bool {
	ents, err := os.ReadDir(l.ProcRoot)
	if err != nil {
		return true
	}
	for _, e := range ents {
		if !isPID(e.Name()) {
			continue
		}
		exe, err := os.Readlink(filepath.Join(l.ProcRoot, e.Name(), "exe"))
		if err != nil {
			continue // gone, or another user's process
		}
		exe = strings.TrimSuffix(exe, " (deleted)")
		for _, want := range l.Exes {
			if exe == want {
				return true
			}
		}
	}
	return false
}

// Poll calls onLock once each time the screen goes from unlocked to
// locked, checking every interval until stop is closed.
func (l LockWatch) Poll(interval time.Duration, stop <-chan struct{}, onLock func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	was := false
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			now := l.Locked()
			if now && !was {
				onLock()
			}
			was = now
		}
	}
}
