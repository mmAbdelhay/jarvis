//go:build !linux

package server

import (
	"errors"
	"net"
)

func peerCred(*net.UnixConn) (int32, uint32, error) {
	return 0, 0, errors.New("the peer check needs Linux (SO_PEERCRED)")
}
