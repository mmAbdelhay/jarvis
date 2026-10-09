package wlcu

// Shm is a shared-memory buffer handed to the compositor by fd.
type Shm struct {
	FD   int
	Mem  []byte
	free func()
}

// Close zeroes the memory (screen pixels and keymaps never linger), then
// unmaps it and closes the fd.
func (s *Shm) Close() {
	clear(s.Mem)
	s.Mem = nil
	if s.free != nil {
		s.free()
		s.free = nil
	}
	s.FD = -1
}

// Allocator makes Shm buffers.
type Allocator interface {
	Alloc(size int) (*Shm, error)
}
