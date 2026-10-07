"""A stand-in for NetworkManager's connectivity-check endpoint, served from
the host. Under QEMU user networking the guest reaches the host at 10.0.2.2,
so the smoke run points NetworkManager at http://10.0.2.2:PORT/nm and the
"full" verdict does not depend on network-test.debian.org being reachable
from the CI runner. Answers exactly like that endpoint."""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY = b"NetworkManager is online\n"


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (http.server's naming)
        if self.path != "/nm":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("X-NetworkManager-Status", "online")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def start(port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
