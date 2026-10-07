package install

import (
	"context"
	"errors"
	"fmt"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
)

// Object is what godbus exports: exactly the four methods of contracts §1.
type Object struct{ B *Backend }

func busErr(err error) *dbus.Error {
	var be *BusError
	if errors.As(err, &be) {
		return dbus.NewError(be.Name, []any{be.Message})
	}
	return dbus.MakeFailedError(err)
}

func (o *Object) Probe(sender dbus.Sender) (string, *dbus.Error) {
	s, err := o.B.Probe(context.Background(), string(sender))
	if err != nil {
		return "", busErr(err)
	}
	return s, nil
}

func (o *Object) Plan(sender dbus.Sender, choices string) (string, *dbus.Error) {
	s, err := o.B.Plan(context.Background(), string(sender), choices)
	if err != nil {
		return "", busErr(err)
	}
	return s, nil
}

func (o *Object) Execute(sender dbus.Sender, planID, secrets string) *dbus.Error {
	if err := o.B.Execute(context.Background(), string(sender), planID, secrets); err != nil {
		return busErr(err)
	}
	return nil
}

func (o *Object) Cancel(sender dbus.Sender) *dbus.Error {
	if err := o.B.Cancel(context.Background(), string(sender)); err != nil {
		return busErr(err)
	}
	return nil
}

// Signals emits contracts §1's signals on conn.
type Signals struct{ Conn *dbus.Conn }

func (s Signals) emit(name string, args ...any) {
	_ = s.Conn.Emit(ObjectPath, Interface+"."+name, args...)
}

func (s Signals) Progress(step string, pct int, detail string) {
	s.emit("Progress", step, int32(pct), detail)
}
func (s Signals) ModelProgress(pct int, detail string) { s.emit("ModelProgress", int32(pct), detail) }
func (s Signals) Finished(ok bool, step, msg string)   { s.emit("Finished", ok, step, msg) }

const introspectXML = `<node>
 <interface name="` + Interface + `">
  <method name="Probe"><arg name="result" type="s" direction="out"/></method>
  <method name="Plan"><arg name="choices" type="s" direction="in"/><arg name="plan" type="s" direction="out"/></method>
  <method name="Execute"><arg name="planId" type="s" direction="in"/><arg name="secretsJson" type="s" direction="in"/></method>
  <method name="Cancel"/>
  <signal name="Progress"><arg name="stepId" type="s"/><arg name="percent" type="i"/><arg name="detail" type="s"/></signal>
  <signal name="ModelProgress"><arg name="percent" type="i"/><arg name="detail" type="s"/></signal>
  <signal name="Finished"><arg name="ok" type="b"/><arg name="errorStep" type="s"/><arg name="message" type="s"/></signal>
 </interface>` + introspect.IntrospectDataString + `</node>`

// Export publishes o on conn, wires its signals, and claims the bus name.
func Export(conn *dbus.Conn, o *Object) error {
	o.B.Deps.Events = Signals{Conn: conn}
	if err := conn.Export(o, ObjectPath, Interface); err != nil {
		return err
	}
	if err := conn.Export(introspect.Introspectable(introspectXML), ObjectPath, "org.freedesktop.DBus.Introspectable"); err != nil {
		return err
	}
	r, err := conn.RequestName(BusName, dbus.NameFlagDoNotQueue)
	if err != nil {
		return err
	}
	if r != dbus.RequestNameReplyPrimaryOwner {
		return fmt.Errorf("%s is already owned", BusName)
	}
	return nil
}
