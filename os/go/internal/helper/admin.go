package helper

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// Admin methods (Rafiq M3 contracts §1, §5.5-6): password tier. Every call is
// authorized by polkit (os.jarvis.helper.admin, a yes for group jarvis-admins
// only) and then carries the calling user's own password, which the helper
// verifies with PAM before acting. After three wrong passwords within five
// minutes the caller is refused for five minutes. Passwords are never logged,
// returned or put in argv.

const (
	userTimeout   = 2 * time.Minute
	formatTimeout = 10 * time.Minute
	minHumanUID   = 1000
	nobodyUID     = 65534
	adminGroup    = "sudo"
)

// CallerUIDs finds the UID of a D-Bus caller (SystemAuthorizer does).
type CallerUIDs interface {
	UnixUser(ctx context.Context, sender string) (uint32, error)
}

type account struct {
	name     string
	uid, gid int
}

// accounts reads passwd from Etc ("/etc").
func (s *Service) accounts() ([]account, error) {
	b, err := fs.ReadFile(s.Etc, "passwd")
	if err != nil {
		return nil, err
	}
	var out []account
	sc := bufio.NewScanner(strings.NewReader(string(b)))
	for sc.Scan() {
		f := strings.Split(sc.Text(), ":")
		if len(f) < 7 {
			continue
		}
		uid, err1 := strconv.Atoi(f[2])
		gid, err2 := strconv.Atoi(f[3])
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, account{name: f[0], uid: uid, gid: gid})
	}
	return out, nil
}

// admins returns the human members of the sudo group (by membership list
// or primary group).
func (s *Service) admins(accts []account) map[string]bool {
	out := map[string]bool{}
	b, err := fs.ReadFile(s.Etc, "group")
	if err != nil {
		return out
	}
	gid := -1
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Split(line, ":")
		if len(f) < 4 || f[0] != adminGroup {
			continue
		}
		gid, _ = strconv.Atoi(f[2])
		for _, m := range strings.Split(f[3], ",") {
			if m != "" {
				out[m] = true
			}
		}
	}
	human := map[string]bool{}
	for _, a := range accts {
		if a.uid >= minHumanUID && a.uid != nobodyUID && (out[a.name] || a.gid == gid) {
			human[a.name] = true
		}
	}
	return human
}

// verifyAdmin checks adminPassword for the calling user and returns that
// account. Wrong passwords are throttled per user.
func (s *Service) verifyAdmin(ctx context.Context, sender, adminPassword string) (account, error) {
	if err := validate.Password(adminPassword); err != nil {
		return account{}, refuse(helperapi.ErrDenied, "the administrator password is required")
	}
	uid, err := s.Callers.UnixUser(ctx, sender)
	if err != nil {
		return account{}, refuse(helperapi.ErrDenied, "cannot identify the caller")
	}
	accts, err := s.accounts()
	if err != nil {
		return account{}, refuse(helperapi.ErrDenied, "cannot read the user list")
	}
	var caller account
	found := false
	for _, a := range accts {
		if a.uid == int(uid) {
			caller, found = a, true
			break
		}
	}
	if !found {
		return account{}, refuse(helperapi.ErrDenied, "the calling user has no account")
	}
	now := s.Now()
	s.failMu.Lock()
	defer s.failMu.Unlock()
	if s.fails == nil {
		s.fails = map[string]*failState{}
	}
	st := s.fails[caller.name]
	if st == nil {
		st = &failState{}
		s.fails[caller.name] = st
	}
	if now.Before(st.lockedUntil) {
		return account{}, refuse(helperapi.ErrDenied, "too many wrong passwords; try again in %d minutes", int(st.lockedUntil.Sub(now).Minutes())+1)
	}
	recent := st.times[:0]
	for _, t := range st.times {
		if now.Sub(t) < failWindow {
			recent = append(recent, t)
		}
	}
	st.times = recent
	if err := s.Pass.Verify(ctx, caller.name, adminPassword); err != nil {
		if !errors.Is(err, ErrBadPassword) {
			return account{}, refuse(helperapi.ErrDenied, "cannot check the password")
		}
		st.times = append(st.times, now)
		if len(st.times) >= maxFailures {
			st.times, st.lockedUntil = nil, now.Add(lockFor)
			return account{}, refuse(helperapi.ErrDenied, "wrong password; too many attempts, try again in 5 minutes")
		}
		return account{}, refuse(helperapi.ErrDenied, "wrong password")
	}
	st.times = nil
	return caller, nil
}

func find(accts []account, name string) (account, bool) {
	for _, a := range accts {
		if a.name == name {
			return a, true
		}
	}
	return account{}, false
}

// AddUser creates a standard (non-admin) account with a home folder. The
// new password is set so the account is usable at once (contracts §5.6).
func (s *Service) AddUser(ctx context.Context, sender, adminPassword, username, fullName, newPassword string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.Username(username); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := validate.FullName(fullName); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := validate.Password(newPassword); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionAdmin); err != nil {
		return helperapi.Outcome{}, err
	}
	if _, err := s.verifyAdmin(ctx, sender, adminPassword); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	accts, err := s.accounts()
	if err != nil {
		return helperapi.Outcome{}, refuse(helperapi.ErrInvalid, "cannot read the user list: %v", err)
	}
	if _, ok := find(accts, username); ok {
		return helperapi.Outcome{}, refuse(helperapi.ErrInvalid, "a user called %s already exists", username)
	}
	out := s.run(ctx, userTimeout, "useradd", "--create-home", "--user-group", "--shell", "/bin/bash", "--comment", fullName, "--", username)
	if !out.OK {
		return out, nil
	}
	// The password goes over stdin ("name:password"), never argv. If it
	// cannot be set the half-made account is removed again.
	out = s.runCmd(ctx, execx.Cmd{Name: "chpasswd", Stdin: []byte(username + ":" + newPassword + "\n"), Timeout: userTimeout})
	if !out.OK {
		s.run(ctx, userTimeout, "userdel", "--remove", "--", username)
	}
	return out, nil
}

// RemoveUser deletes an account (and its home folder unless keepHome). It
// refuses the caller, system accounts and the last administrator.
func (s *Service) RemoveUser(ctx context.Context, sender, adminPassword, username string, keepHome bool) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.Username(username); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionAdmin); err != nil {
		return helperapi.Outcome{}, err
	}
	caller, err := s.verifyAdmin(ctx, sender, adminPassword)
	if err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	accts, err := s.accounts()
	if err != nil {
		return helperapi.Outcome{}, refuse(helperapi.ErrInvalid, "cannot read the user list: %v", err)
	}
	target, ok := find(accts, username)
	if !ok {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "there is no user called %s", username)
	}
	if target.uid < minHumanUID || target.uid == nobodyUID {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%s is a system account", username)
	}
	if caller.uid == target.uid {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "you cannot remove the account you are using")
	}
	if admins := s.admins(accts); admins[username] && len(admins) <= 1 {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%s is the last administrator", username)
	}
	args := []string{"--", username}
	if !keepHome {
		args = append([]string{"--remove"}, args...)
	}
	return s.run(ctx, userTimeout, "userdel", args...), nil
}

// flexBool reads lsblk's RM/HOTPLUG, a JSON bool in util-linux ≥ 2.37 and
// "0"/"1" before.
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	s := strings.Trim(string(data), `"`)
	*b = flexBool(s == "true" || s == "1")
	return nil
}

type blockDev struct {
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	Type        string     `json:"type"`
	RM          flexBool   `json:"rm"`
	Tran        *string    `json:"tran"`
	Mountpoints []*string  `json:"mountpoints"`
	Children    []blockDev `json:"children"`
}

func (d blockDev) mounted() bool {
	for _, m := range d.Mountpoints {
		if m != nil && *m != "" {
			return true
		}
	}
	for _, c := range d.Children {
		if c.mounted() {
			return true
		}
	}
	return false
}

// partitionPath is the first partition of a whole disk.
func partitionPath(disk string) string {
	if last := disk[len(disk)-1]; last >= '0' && last <= '9' {
		return disk + "p1"
	}
	return disk + "1"
}

// FormatRemovable erases a removable USB/SD drive and makes one partition
// with a fresh filesystem. It refuses anything that is not a removable
// whole disk on USB or MMC, and any drive with something mounted.
func (s *Service) FormatRemovable(ctx context.Context, sender, adminPassword, device, fsType, label string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.WholeDisk(device); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	label, err := validate.FSLabel(fsType, label)
	if err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionAdmin); err != nil {
		return helperapi.Outcome{}, err
	}
	caller, err := s.verifyAdmin(ctx, sender, adminPassword)
	if err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.Run.Run(ctx, execx.Cmd{Name: "lsblk", Args: []string{"--json", "--bytes", "--output", "NAME,PATH,TYPE,RM,TRAN,MOUNTPOINTS"}, Timeout: queryTimeout})
	if err != nil || res.ExitCode != 0 {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "cannot list drives")
	}
	var tree struct {
		Blockdevices []blockDev `json:"blockdevices"`
	}
	if err := json.Unmarshal(res.Stdout, &tree); err != nil {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "cannot list drives")
	}
	var disk *blockDev
	for i := range tree.Blockdevices {
		if tree.Blockdevices[i].Path == device {
			disk = &tree.Blockdevices[i]
		}
	}
	if disk == nil {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not connected", device)
	}
	tran := ""
	if disk.Tran != nil {
		tran = *disk.Tran
	}
	if disk.Type != "disk" || !bool(disk.RM) || !(tran == "usb" || tran == "mmc" || strings.HasPrefix(disk.Name, "mmcblk")) {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%s is not a removable USB or SD drive", device)
	}
	if disk.mounted() {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%s is in use; unmount it first", device)
	}
	code := map[string]string{"exfat": "7", "vfat": "c", "ext4": "83"}[fsType]
	steps := []execx.Cmd{
		{Name: "wipefs", Args: []string{"--all", "--force", "--", device}},
		{Name: "sfdisk", Args: []string{"--quiet", "--wipe", "always", "--wipe-partitions", "always", "--", device}, Stdin: []byte("label: dos\ntype=" + code + "\n")},
		{Name: "udevadm", Args: []string{"settle", "--timeout=15"}},
	}
	part := partitionPath(device)
	switch fsType {
	case "exfat":
		args := []string{}
		if label != "" {
			args = append(args, "-L", label)
		}
		steps = append(steps, execx.Cmd{Name: "mkfs.exfat", Args: append(args, "--", part)})
	case "vfat":
		args := []string{"-F", "32"}
		if label != "" {
			args = append(args, "-n", label)
		}
		steps = append(steps, execx.Cmd{Name: "mkfs.vfat", Args: append(args, "--", part)})
	case "ext4":
		args := []string{"-F", "-q"}
		if label != "" {
			args = append(args, "-L", label)
		}
		// The caller owns the new filesystem's root, so they can write to it.
		args = append(args, "-E", fmt.Sprintf("root_owner=%d:%d", caller.uid, caller.gid))
		steps = append(steps, execx.Cmd{Name: "mkfs.ext4", Args: append(args, "--", part)})
	}
	var out helperapi.Outcome
	for _, c := range steps {
		c.Timeout = formatTimeout
		out = s.runCmd(ctx, c)
		if !out.OK {
			return out, nil
		}
	}
	return out, nil
}
