package install

import "syscall"

// DiskUsed reports the bytes in use on the file system holding path
// (copy-step progress). Linux and macOS both have statfs(2).
func DiskUsed(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Blocks-st.Bfree) * int64(st.Bsize), nil
}
