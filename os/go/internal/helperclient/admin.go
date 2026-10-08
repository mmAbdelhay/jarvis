package helperclient

import (
	"context"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// AddUser calls the helper's admin method (Rafiq M3 contracts §1).
func (c *Client) AddUser(ctx context.Context, adminPassword, username, fullName, newPassword string) (helperapi.Outcome, error) {
	return c.call(ctx, helperapi.AdminCallTimeout, "AddUser", adminPassword, username, fullName, newPassword)
}

// RemoveUser calls the helper's admin method.
func (c *Client) RemoveUser(ctx context.Context, adminPassword, username string, keepHome bool) (helperapi.Outcome, error) {
	return c.call(ctx, helperapi.AdminCallTimeout, "RemoveUser", adminPassword, username, keepHome)
}

// FormatRemovable calls the helper's admin method.
func (c *Client) FormatRemovable(ctx context.Context, adminPassword, device, fs, label string) (helperapi.Outcome, error) {
	return c.call(ctx, helperapi.AdminCallTimeout, "FormatRemovable", adminPassword, device, fs, label)
}

var _ helperapi.Admin = (*Client)(nil)
