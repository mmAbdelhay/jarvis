package install

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
)

// LogPath is the live-session copy of the install log, readable by the
// installer UI for "Save log to USB". Finish copies it into the target.
const LogPath = RunDir + "/install.log"

// TargetLogPath is where the installed system keeps it (design §5.2).
const TargetLogPath = "/target/var/log/jarvis-installer.log"

// minSecretLen: secrets shorter than this are not searched for in argv
// — a 3-letter password equal to the username would otherwise
// "match" every useradd argument. Secrets never reach argv or the log by
// construction (stdin only); the search is a second line of defence.
const minSecretLen = 8

// minLogSecretLen is the minimum secret length scrubbed from log text.
const minLogSecretLen = 4

// Logger is the redacted install log. Every line passes redact.String and
// has every registered secret replaced, then goes to w and to memory.
type Logger struct {
	mu      sync.Mutex
	w       io.Writer
	now     func() time.Time
	secrets []string
	all     bytes.Buffer
	tail    []string
}

// NewLogger writes to w (may be nil) with timestamps from now.
func NewLogger(w io.Writer, now func() time.Time) *Logger {
	if now == nil {
		now = time.Now
	}
	return &Logger{w: w, now: now}
}

// AddSecret registers a value that must never appear in the log.
func (l *Logger) AddSecret(s string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(s) >= minLogSecretLen {
		l.secrets = append(l.secrets, s)
	}
}

func (l *Logger) scrub(s string) string {
	for _, sec := range l.secrets {
		s = strings.ReplaceAll(s, sec, "[redacted:secret]")
	}
	return redact.String(s)
}

// Printf logs one or more lines.
func (l *Logger) Printf(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := l.now().UTC().Format("15:04:05")
	for _, line := range strings.Split(strings.TrimRight(l.scrub(fmt.Sprintf(format, a...)), "\n"), "\n") {
		out := ts + " " + line + "\n"
		l.all.WriteString(out)
		if l.w != nil {
			io.WriteString(l.w, out)
		}
		l.tail = append(l.tail, line)
		if len(l.tail) > 50 {
			l.tail = l.tail[1:]
		}
	}
}

// Tail returns the last n lines (without timestamps).
func (l *Logger) Tail(n int) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n > len(l.tail) {
		n = len(l.tail)
	}
	return append([]string(nil), l.tail[len(l.tail)-n:]...)
}

// Bytes returns the whole log.
func (l *Logger) Bytes() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]byte(nil), l.all.Bytes()...)
}
