package helper

import (
	"context"
	"errors"
	"fmt"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// Object is what godbus exports. Every exported method here becomes a D-Bus
// method, so it has exactly the five of M1 contracts §2, AptUpgrade and
// FlatpakUpdate (M2 contracts §2) and the three admin methods of Rafiq M3
// contracts §1, and nothing else. The
// dbus.Sender parameter is filled in by godbus and is not part of the
// D-Bus signature.
type Object struct{ Svc *Service }

func (o *Object) AptInstall(sender dbus.Sender, names []string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.AptInstall(context.Background(), string(sender), names))
}

func (o *Object) AptRemove(sender dbus.Sender, names []string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.AptRemove(context.Background(), string(sender), names))
}

func (o *Object) FlatpakInstall(sender dbus.Sender, refs []string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.FlatpakInstall(context.Background(), string(sender), refs))
}

func (o *Object) FlatpakRemove(sender dbus.Sender, refs []string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.FlatpakRemove(context.Background(), string(sender), refs))
}

func (o *Object) AptUpgrade(sender dbus.Sender, names []string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.AptUpgrade(context.Background(), string(sender), names))
}

func (o *Object) FlatpakUpdate(sender dbus.Sender, refs []string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.FlatpakUpdate(context.Background(), string(sender), refs))
}

func (o *Object) RestartUnit(sender dbus.Sender, name string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.RestartUnit(context.Background(), string(sender), name))
}

// AddUser, RemoveUser and FormatRemovable are the admin methods (Rafiq M3
// contracts §1, polkit os.jarvis.helper.admin).
func (o *Object) AddUser(sender dbus.Sender, adminPassword, username, fullName, newPassword string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.AddUser(context.Background(), string(sender), adminPassword, username, fullName, newPassword))
}

func (o *Object) RemoveUser(sender dbus.Sender, adminPassword, username string, keepHome bool) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.RemoveUser(context.Background(), string(sender), adminPassword, username, keepHome))
}

func (o *Object) FormatRemovable(sender dbus.Sender, adminPassword, device, fs, label string) (bool, int32, string, *dbus.Error) {
	return reply(o.Svc.FormatRemovable(context.Background(), string(sender), adminPassword, device, fs, label))
}

func reply(out helperapi.Outcome, err error) (bool, int32, string, *dbus.Error) {
	if err != nil {
		var he *helperapi.Error
		if errors.As(err, &he) && he.Name != "" {
			return false, 0, "", dbus.NewError(he.Name, []any{he.Message})
		}
		return false, 0, "", dbus.MakeFailedError(err)
	}
	return out.OK, out.ExitCode, out.StderrTail, nil
}

const introspectXML = `<node>
 <interface name="` + helperapi.Interface + `">
  <method name="AptInstall"><arg name="names" type="as" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="AptRemove"><arg name="names" type="as" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="FlatpakInstall"><arg name="refs" type="as" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="FlatpakRemove"><arg name="refs" type="as" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="AptUpgrade"><arg name="names" type="as" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="FlatpakUpdate"><arg name="refs" type="as" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="AddUser"><arg name="adminPassword" type="s" direction="in"/><arg name="username" type="s" direction="in"/><arg name="fullName" type="s" direction="in"/><arg name="newPassword" type="s" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="RemoveUser"><arg name="adminPassword" type="s" direction="in"/><arg name="username" type="s" direction="in"/><arg name="keepHome" type="b" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="FormatRemovable"><arg name="adminPassword" type="s" direction="in"/><arg name="device" type="s" direction="in"/><arg name="fs" type="s" direction="in"/><arg name="label" type="s" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
  <method name="RestartUnit"><arg name="name" type="s" direction="in"/><arg name="ok" type="b" direction="out"/><arg name="exitCode" type="i" direction="out"/><arg name="stderrTail" type="s" direction="out"/></method>
 </interface>` + introspect.IntrospectDataString + `</node>`

// Export publishes o on conn and claims the bus name. It fails if another
// process already owns the name.
func Export(conn *dbus.Conn, o *Object) error {
	if err := conn.Export(o, helperapi.ObjectPath, helperapi.Interface); err != nil {
		return err
	}
	if err := conn.Export(introspect.Introspectable(introspectXML), helperapi.ObjectPath, "org.freedesktop.DBus.Introspectable"); err != nil {
		return err
	}
	r, err := conn.RequestName(helperapi.BusName, dbus.NameFlagDoNotQueue)
	if err != nil {
		return err
	}
	if r != dbus.RequestNameReplyPrimaryOwner {
		return fmt.Errorf("%s is already owned", helperapi.BusName)
	}
	return nil
}
