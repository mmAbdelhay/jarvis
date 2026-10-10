//go:build !linux

package wlcu

import "errors"

type noAllocator struct{}

// DefaultAllocator: shared memory for Wayland is Linux-only here; tests
// on macOS pass their own Allocator.
func DefaultAllocator() Allocator { return noAllocator{} }

func (noAllocator) Alloc(int) (*Shm, error) {
	return nil, errors.New("wlcu: shared memory needs Linux")
}
