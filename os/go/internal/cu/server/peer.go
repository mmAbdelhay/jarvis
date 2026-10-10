package server

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Expected describes the only program allowed to connect: jarvisd, run
// as `/usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run`
// (M1 contracts §6.16) by the same user.
type Expected struct {
	Exe    string // /proc/<pid>/exe must equal this
	Script string // argv[1] must equal this ("" skips the check: tests only)
	UID    int
}

// VerifyProc checks a peer's credentials against Expected.
func VerifyProc(procRoot string, pid int32, uid uint32, want Expected) error {
	if want.Exe == "" {
		return errors.New("no expected peer program configured")
	}
	if int(uid) != want.UID {
		return fmt.Errorf("peer uid %d is not %d", uid, want.UID)
	}
	dir := filepath.Join(procRoot, strconv.Itoa(int(pid)))
	exe, err := os.Readlink(filepath.Join(dir, "exe"))
	if err != nil {
		return fmt.Errorf("peer executable: %w", err)
	}
	if exe != want.Exe {
		return fmt.Errorf("peer is %s, not %s", exe, want.Exe)
	}
	if want.Script == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "cmdline"))
	if err != nil {
		return fmt.Errorf("peer command line: %w", err)
	}
	args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
	if len(args) < 2 || args[1] != want.Script {
		return fmt.Errorf("peer is not running %s", want.Script)
	}
	return nil
}

// PeerCheck accepts or refuses a new connection.
type PeerCheck func(c *net.UnixConn) error

// JarvisdCheck asks the kernel who the peer is (SO_PEERCRED) and checks /proc.
func JarvisdCheck(procRoot string, want Expected) PeerCheck {
	return func(c *net.UnixConn) error {
		pid, uid, err := peerCred(c)
		if err != nil {
			return err
		}
		return VerifyProc(procRoot, pid, uid, want)
	}
}
