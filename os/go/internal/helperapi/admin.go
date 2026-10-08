package helperapi

import (
	"context"
	"strconv"
	"time"
)

// AdminCallTimeout bounds one admin call: the polkit password dialog can
// wait for the user, and formatting a large drive takes minutes.
const AdminCallTimeout = 15 * time.Minute

// Admin is jarvis-helper's password tier (Rafiq M3 contracts §1, §5.5-6):
// every method carries the calling user's own password, which the helper
// verifies with PAM before acting (polkit ActionAdmin is a group gate only).
type Admin interface {
	AddUser(ctx context.Context, adminPassword, username, fullName, newPassword string) (Outcome, error)
	RemoveUser(ctx context.Context, adminPassword, username string, keepHome bool) (Outcome, error)
	FormatRemovable(ctx context.Context, adminPassword, device, fs, label string) (Outcome, error)
}

// The Fake never records a password.
func (f *Fake) AddUser(_ context.Context, _, username, fullName, _ string) (Outcome, error) {
	return f.call("AddUser", []string{username, fullName})
}
func (f *Fake) RemoveUser(_ context.Context, _, username string, keepHome bool) (Outcome, error) {
	return f.call("RemoveUser", []string{username, "keepHome=" + strconv.FormatBool(keepHome)})
}
func (f *Fake) FormatRemovable(_ context.Context, _, device, fs, label string) (Outcome, error) {
	return f.call("FormatRemovable", []string{device, fs, label})
}

var _ Admin = (*Fake)(nil)
