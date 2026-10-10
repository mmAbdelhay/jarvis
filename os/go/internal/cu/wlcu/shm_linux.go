//go:build linux

package wlcu

import "golang.org/x/sys/unix"

type memfdAllocator struct{}

// DefaultAllocator uses memfd_create + mmap (no files on disk).
func DefaultAllocator() Allocator { return memfdAllocator{} }

func (memfdAllocator) Alloc(size int) (*Shm, error) {
	fd, err := unix.MemfdCreate("jarvis-cu", unix.MFD_CLOEXEC)
	if err != nil {
		return nil, err
	}
	if err := unix.Ftruncate(fd, int64(size)); err != nil {
		unix.Close(fd)
		return nil, err
	}
	mem, err := unix.Mmap(fd, 0, size, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &Shm{FD: fd, Mem: mem, free: func() {
		unix.Munmap(mem)
		unix.Close(fd)
	}}, nil
}
