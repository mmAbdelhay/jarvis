// Package wl is a minimal Wayland client written for one job: listing,
// focusing and closing windows through labwc's
// zwlr_foreign_toplevel_manager_v1 (wlr-foreign-toplevel-management,
// version 3). It speaks the wire protocol directly: no libwayland, no cgo,
// so `make dist` stays a static CGO_ENABLED=0 build and the tests run on
// any OS against a scripted fake compositor. None of the requests used
// here pass file descriptors, so a plain stream is enough.
package wl

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Wayland's wire format is host-endian; every Rafiq target is little-endian.
var order = binary.LittleEndian

// maxMessage is the protocol's 16-bit size limit.
const maxMessage = 1<<16 - 1

// Message is one wire message: header (object id, size<<16|opcode) + args.
type Message struct {
	Object uint32
	Opcode uint16
	Args   []byte
}

// Encode returns the message's bytes.
func (m Message) Encode() ([]byte, error) {
	size := 8 + len(m.Args)
	if size%4 != 0 {
		return nil, fmt.Errorf("wl: unaligned message size %d", size)
	}
	if size > maxMessage {
		return nil, fmt.Errorf("wl: message too large (%d bytes)", size)
	}
	b := make([]byte, 8, size)
	order.PutUint32(b[0:], m.Object)
	order.PutUint32(b[4:], uint32(size)<<16|uint32(m.Opcode))
	return append(b, m.Args...), nil
}

// ReadMessage reads one message.
func ReadMessage(r io.Reader) (Message, error) {
	var h [8]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return Message{}, err
	}
	word := order.Uint32(h[4:])
	size := int(word >> 16)
	if size < 8 || size%4 != 0 {
		return Message{}, fmt.Errorf("wl: bad message size %d", size)
	}
	args := make([]byte, size-8)
	if _, err := io.ReadFull(r, args); err != nil {
		return Message{}, err
	}
	return Message{Object: order.Uint32(h[0:]), Opcode: uint16(word & 0xffff), Args: args}, nil
}

// Builder appends typed arguments.
type Builder struct{ b []byte }

// Uint appends a uint, int, object or new_id argument.
func (w *Builder) Uint(v uint32) *Builder {
	w.b = order.AppendUint32(w.b, v)
	return w
}

// String appends a string argument (length with NUL, padded to 4).
func (w *Builder) String(s string) *Builder {
	w.Uint(uint32(len(s) + 1))
	w.b = append(w.b, s...)
	w.b = append(w.b, 0)
	for len(w.b)%4 != 0 {
		w.b = append(w.b, 0)
	}
	return w
}

// Array appends an array argument (byte length, data padded to 4).
func (w *Builder) Array(data []byte) *Builder {
	w.Uint(uint32(len(data)))
	w.b = append(w.b, data...)
	for len(w.b)%4 != 0 {
		w.b = append(w.b, 0)
	}
	return w
}

// Bytes returns the arguments.
func (w *Builder) Bytes() []byte { return w.b }

// ErrShort means a message's arguments ended early.
var ErrShort = errors.New("wl: truncated arguments")

// Reader reads typed arguments in order.
type Reader struct {
	b   []byte
	err error
}

// NewReader reads args.
func NewReader(args []byte) *Reader { return &Reader{b: args} }

// Err is the first decoding error.
func (r *Reader) Err() error { return r.err }

// Uint reads a uint, int, object or new_id argument.
func (r *Reader) Uint() uint32 {
	if r.err != nil || len(r.b) < 4 {
		r.err = ErrShort
		return 0
	}
	v := order.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *Reader) blob() []byte {
	n := int(r.Uint())
	padded := (n + 3) &^ 3
	if r.err != nil || n < 0 || padded > len(r.b) {
		r.err = ErrShort
		return nil
	}
	data := r.b[:n]
	r.b = r.b[padded:]
	return data
}

// String reads a string argument (a null string reads as "").
func (r *Reader) String() string {
	data := r.blob()
	if len(data) == 0 {
		return ""
	}
	if data[len(data)-1] != 0 {
		r.err = errors.New("wl: string without NUL")
		return ""
	}
	return string(data[:len(data)-1])
}

// Array reads an array argument.
func (r *Reader) Array() []byte { return r.blob() }
