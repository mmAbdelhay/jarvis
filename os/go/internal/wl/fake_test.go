package wl

import (
	"encoding/binary"
	"net"
	"sync"
	"testing"
)

// fakeWindow is one window the fake compositor shows.
type fakeWindow struct {
	appID, title string
	states       []uint32
}

// fake is a scripted compositor on the server end of a net.Pipe. It
// answers exactly the requests this client makes and records them.
type fake struct {
	t        *testing.T
	conn     net.Conn
	globals  []string // interfaces to advertise, in order
	windows  []fakeWindow
	noSync   bool // never answer wl_display.sync
	mu       sync.Mutex
	registry uint32
	manager  uint32
	seat     uint32
	handles  []uint32 // handle id per window index (0 when closed)
	log      []string
	nextNew  uint32
}

func startFake(t *testing.T, f *fake) (*Client, error) {
	t.Helper()
	server, client := net.Pipe()
	f.t, f.conn, f.nextNew = t, server, 0xff000000
	go f.serve()
	t.Cleanup(func() { server.Close(); client.Close() })
	return NewClient(client, 0)
}

func (f *fake) emit(obj uint32, op uint16, b *Builder) {
	var args []byte
	if b != nil {
		args = b.Bytes()
	}
	data, _ := Message{Object: obj, Opcode: op, Args: args}.Encode()
	f.conn.Write(data)
}

func (f *fake) record(s string) {
	f.mu.Lock()
	f.log = append(f.log, s)
	f.mu.Unlock()
}

func (f *fake) Log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

func stateArray(states []uint32) []byte {
	b := make([]byte, 0, 4*len(states))
	for _, s := range states {
		b = binary.LittleEndian.AppendUint32(b, s)
	}
	return b
}

// announce sends one window's toplevel, title, app_id, state and done.
func (f *fake) announce(i int) {
	f.nextNew++
	id := f.nextNew
	f.handles = append(f.handles, id)
	w := f.windows[i]
	f.emit(f.manager, evManagerToplevel, new(Builder).Uint(id))
	f.emit(id, evHandleTitle, new(Builder).String(w.title))
	f.emit(id, evHandleAppID, new(Builder).String(w.appID))
	f.emit(id, evHandleState, new(Builder).Array(stateArray(w.states)))
	f.emit(id, evHandleDone, nil)
}

func (f *fake) indexOf(handle uint32) int {
	for i, h := range f.handles {
		if h == handle {
			return i
		}
	}
	return -1
}

func (f *fake) serve() {
	for {
		m, err := ReadMessage(f.conn)
		if err != nil {
			return
		}
		r := NewReader(m.Args)
		switch {
		case m.Object == displayID && m.Opcode == opDisplayGetRegistry:
			f.registry = r.Uint()
			for i, iface := range f.globals {
				version := uint32(7)
				if iface == ManagerInterface {
					version = 3
				}
				f.emit(f.registry, evRegistryGlobal, new(Builder).Uint(uint32(i+1)).String(iface).Uint(version))
			}
		case m.Object == displayID && m.Opcode == opDisplaySync:
			cb := r.Uint()
			if !f.noSync {
				f.emit(cb, evCallbackDone, new(Builder).Uint(1))
				f.emit(displayID, evDisplayDeleteID, new(Builder).Uint(cb))
			}
		case m.Object == f.registry && m.Opcode == opRegistryBind:
			_, iface, version, id := r.Uint(), r.String(), r.Uint(), r.Uint()
			f.record("bind " + iface + " v" + string(rune('0'+version)))
			switch iface {
			case ManagerInterface:
				f.manager = id
				for i := range f.windows {
					f.announce(i)
				}
			case SeatInterface:
				f.seat = id
			}
		case m.Opcode == opHandleActivate && f.indexOf(m.Object) >= 0:
			seat := r.Uint()
			i := f.indexOf(m.Object)
			if seat != f.seat {
				f.t.Errorf("activate with seat %d, bound seat is %d", seat, f.seat)
			}
			f.record("activate " + f.windows[i].appID)
			for j, h := range f.handles {
				if h == 0 {
					continue
				}
				var st []uint32
				if j == i {
					st = []uint32{stateActivated}
				}
				f.emit(h, evHandleState, new(Builder).Array(stateArray(st)))
				f.emit(h, evHandleDone, nil)
			}
		case m.Opcode == opHandleClose && f.indexOf(m.Object) >= 0:
			i := f.indexOf(m.Object)
			f.record("close " + f.windows[i].appID)
			f.emit(m.Object, evHandleClosed, nil)
			f.handles[i] = 0
		case m.Opcode == opHandleDestroy:
			f.record("destroy")
		case m.Object == 999:
			f.emit(displayID, evDisplayError, new(Builder).Uint(999).Uint(0).String("invalid object 999"))
		}
	}
}
