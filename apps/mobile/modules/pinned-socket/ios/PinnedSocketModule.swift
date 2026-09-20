import CryptoKit
import ExpoModulesCore

// A fingerprint-pinned WebSocket transport. The module trusts exactly one
// certificate per connection — the leaf whose SHA-256 DER fingerprint the
// caller supplies — never the system trust store, never the hostname,
// never the chain or validity dates (ruling: "The phone trusts exactly one
// certificate per pairing", global-constraints.md). `NSAppTransportSecurity`
// is not touched: this module dials `wss://` only and proves trust itself
// during the TLS handshake, so no ATS exception is needed or wanted.
public class PinnedSocketModule: Module {
  // `connections` is written from the JS-calling thread (`open`/`close`,
  // and `onClosed` fired from a network callback thread) and read from
  // both `send`/`close` (JS thread) and `onClosed` (network thread). A
  // single lock around every access avoids the undefined behaviour of
  // concurrently mutating a Swift `Dictionary`.
  private var connections: [Int: PinnedSocketConnection] = [:]
  private var nextId = 1
  private let connectionsLock = NSLock()

  private func withConnections<T>(_ body: (inout [Int: PinnedSocketConnection], inout Int) -> T) -> T {
    connectionsLock.lock()
    defer { connectionsLock.unlock() }
    return body(&connections, &nextId)
  }

  public func definition() -> ModuleDefinition {
    Name("PinnedSocket")

    Events("onOpen", "onMessage", "onClose", "onError")

    Function("open") { (url: String, fingerprintHex: String) -> Int in
      let id = self.withConnections { _, nextId in
        let id = nextId
        nextId += 1
        return id
      }

      let connection = PinnedSocketConnection(
        id: id,
        pinnedFingerprintHex: fingerprintHex.lowercased(),
        onEvent: { [weak self] name, body in
          self?.sendEvent(name, body)
        },
        onClosed: { [weak self] closedId in
          self?.withConnections { connections, _ in
            connections.removeValue(forKey: closedId)
          }
        }
      )
      self.withConnections { connections, _ in
        connections[id] = connection
      }
      connection.connect(urlString: url)
      return id
    }

    Function("send") { (id: Int, text: String) in
      let connection = self.withConnections { connections, _ in connections[id] }
      connection?.send(text: text)
    }

    Function("sendBinary") { (id: Int, base64: String) in
      let connection = self.withConnections { connections, _ in connections[id] }
      connection?.sendBinary(base64: base64)
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      let connection = self.withConnections { connections, _ in connections[id] }
      connection?.close(code: code, reason: reason)
    }
  }
}

/// One pinned WebSocket connection. Owns its own `URLSession` (one per
/// socket, not shared) so a mismatched pin on one connection can never
/// affect another's cached credentials.
private final class PinnedSocketConnection: NSObject, URLSessionWebSocketDelegate {
  // PINNED_SOCKET_MAX_MESSAGE_BYTES (M7 Task 3 / ruling 9): URLSession
  // defaults `maximumMessageSize` to 1 MiB, and a `session:snapshot` `res`
  // or a capped stream push, JSON-escaped, can reach about 1.6 MiB.
  // Exceeding the default closes the socket, which reconnects and
  // re-snapshots in a loop. Set on every task before `resume()`.
  private static let maxMessageBytes = 16_777_216
  private let id: Int
  private let pinnedFingerprintHex: String
  private let onEvent: (String, [String: Any]) -> Void
  private let onClosed: (Int) -> Void

  private var session: URLSession?
  private var task: URLSessionWebSocketTask?

  // `didEmitClose` and `binaryFramesDropped` are read/written from both the
  // JS-calling thread (`send`/`close`) and network callback threads (the
  // `receive` loop, delegate methods run on the session's delegate queue).
  // A lock keeps every access of either serialized.
  private var didEmitClose = false
  private var binaryFramesDropped = 0
  private let stateLock = NSLock()

  /// Atomically marks the connection closed (idempotent — only the first
  /// caller gets `shouldEmit == true`) and returns the binary-frame count
  /// dropped so far, for the one log line at close.
  private func markEmittedAndReadDroppedCount() -> (shouldEmit: Bool, dropped: Int) {
    stateLock.lock()
    defer { stateLock.unlock() }
    if didEmitClose { return (false, 0) }
    didEmitClose = true
    return (true, binaryFramesDropped)
  }

  private func incrementDropped() {
    stateLock.lock()
    binaryFramesDropped += 1
    stateLock.unlock()
  }

  private func isClosed() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return didEmitClose
  }

  init(
    id: Int,
    pinnedFingerprintHex: String,
    onEvent: @escaping (String, [String: Any]) -> Void,
    onClosed: @escaping (Int) -> Void
  ) {
    self.id = id
    self.pinnedFingerprintHex = pinnedFingerprintHex
    self.onEvent = onEvent
    self.onClosed = onClosed
  }

  func connect(urlString: String) {
    guard let url = URL(string: urlString) else {
      // Never emit synchronously inside `open()`/`connect()`: the caller
      // (native-transport.ts) only registers its event route after the
      // native `open` call returns the socket id, so an event fired from
      // within this call would be dropped. Defer to the next runloop turn.
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.emitError("invalid url")
        self.emitClose(code: 1006, reason: "transport")
      }
      return
    }
    // M12 Task 8 (M6 final review N3, deferred): `.ephemeral` — a pinned,
    // single-purpose socket has no reason to share the process's cookie,
    // credential or URL cache storage.
    let configuration = URLSessionConfiguration.ephemeral
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    let task = session.webSocketTask(with: url)
    // Must be set before resume() (PINNED_SOCKET_MAX_MESSAGE_BYTES above).
    task.maximumMessageSize = Self.maxMessageBytes
    self.task = task
    task.resume()
    listen()
  }

  func send(text: String) {
    guard let task, !isClosed() else { return }
    task.send(.string(text)) { [weak self] error in
      guard let self, error != nil else { return }
      // A send failure on an already-live socket is reported generically —
      // never the pinned or presented fingerprint, per the module's "never
      // leaves the module" rule.
      self.emitError("send failed")
    }
  }

  /// Sends one binary WebSocket frame (M8 ruling 1/2: the blob upload
  /// lane). `base64` is decoded to raw bytes here, natively — it never
  /// touches JS as anything but a string, and never touches JSON.
  func sendBinary(base64: String) {
    guard let task, !isClosed() else { return }
    guard let data = Data(base64Encoded: base64) else {
      // A locally undecodable payload never reaches the network, so unlike
      // the genuine send failure below there is no in-flight operation
      // whose own completion would ever report a close. Report it
      // ourselves, the same way close() already does for a self-initiated
      // close: an error, a cancel to free the task, then emitClose
      // directly — so "an error is always followed by close" holds
      // without waiting on a callback that will never come.
      emitError("send failed")
      task.cancel()
      emitClose(code: 1006, reason: "transport")
      return
    }
    // Same completion handling as send(text:) (behaviour rule 5): a
    // genuine network send failure only reports the error here — the
    // close that follows arrives later, from the task's own
    // didCompleteWithError, per the transport contract's documented
    // timing (not necessarily immediate).
    task.send(.data(data)) { [weak self] error in
      guard let self, error != nil else { return }
      self.emitError("send failed")
    }
  }

  func close(code: Int, reason: String) {
    guard let task, !isClosed() else { return }
    // Mirrors Kotlin's `close()` clamp (PinnedSocketModule.kt): OkHttp's
    // `WebSocket.close` throws `IllegalArgumentException` for a code outside
    // 1000 or 3000-4999, or a reason over 123 UTF-8 bytes. Foundation's
    // `cancel(with:reason:)` has no such guard, but nothing invalid should
    // reach it either — same validated shape on both platforms.
    let safeCode = (code == 1000 || (3000...4999).contains(code)) ? code : 1000
    let safeReason = clampReason(reason)
    // `URLSessionWebSocketTask.CloseCode`'s public failable initializer only
    // covers the RFC-defined 1000-1015 range, so `CloseCode(rawValue:)` is
    // `nil` for our 4000-4999 application codes and would otherwise be
    // silently substituted with 1000 (behaviour rule 4 requires 4000-4999
    // and 1000 on both platforms). `CloseCode` is a plain Int-backed enum
    // with no associated values, so its memory layout is the raw Int
    // itself; `unsafeBitCast` from `Int` to `CloseCode` is the documented
    // community workaround for sending a close code Foundation's public
    // initializer does not name. This has not been exercised on a real
    // device/simulator in this environment (no Xcode/Swift toolchain here)
    // — flagged for the manual pass.
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: safeCode)
      ?? unsafeBitCast(safeCode, to: URLSessionWebSocketTask.CloseCode.self)
    task.cancel(with: closeCode, reason: safeReason.data(using: .utf8))
    // `cancel(with:)` tears the socket down immediately; it does not wait
    // for the peer's close frame, so there is no later delegate callback
    // that reliably reports this outcome. We already know what we asked
    // for, so report it ourselves, once, right here — the `receive` loop's
    // subsequent failure becomes a no-op because the connection is now
    // marked closed.
    //
    // Close-timing difference from Android (see PinnedSocketModule.kt): iOS
    // reports its own close immediately, on the caller's code, the instant
    // `close()` runs. It does not wait for the peer to acknowledge.
    emitClose(code: safeCode, reason: safeReason)
  }

  /// Clamps `reason` to at most 123 UTF-8 bytes (the RFC 6455 close-frame
  /// limit OkHttp also enforces on Android), trimming whole `Character`s
  /// from the end so a multi-byte character or grapheme cluster is never
  /// split mid-sequence.
  private func clampReason(_ reason: String) -> String {
    var candidate = reason
    while candidate.utf8.count > 123 {
      candidate.removeLast()
    }
    return candidate
  }

  private func listen() {
    task?.receive { [weak self] result in
      guard let self, !self.isClosed() else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.onEvent("onMessage", ["id": self.id, "text": text])
        case .data:
          // Text frames only (behaviour rule 4): a binary frame is dropped,
          // never delivered, and only its count is ever logged (once, at
          // close).
          self.incrementDropped()
        @unknown default:
          break
        }
        self.listen()
      case .failure:
        // `receive` failing races ahead of `didCloseWith` when the peer
        // (or the network) drops the connection, so `task.closeCode` may
        // already carry the real code the peer sent (e.g. 4410/4401/4426)
        // even though the delegate callback hasn't run yet. Prefer that
        // over the generic 1006 fallback so ruling 9's reactions see the
        // real code on iOS too.
        //
        // If `closeCode` is not set yet, do NOT assume this is a transport
        // failure and emit 1006 here: `didCloseWith` may still be about to
        // fire with the real close code, delivered on the same serial
        // delegate queue. Emitting 1006 from this branch would race a real
        // close and could report the wrong outcome (see re-review N1). Let
        // `urlSession(_:task:didCompleteWithError:)` — which always fires
        // last for the task, after `didCloseWith` would have — report the
        // 1006 "transport" fallback if nothing else has by then.
        if let task = self.task, task.closeCode != .invalid {
          let reasonText = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
          self.emitClose(code: task.closeCode.rawValue, reason: reasonText)
        }
      }
    }
  }

  // MARK: - URLSessionWebSocketDelegate

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    onEvent("onOpen", ["id": id])
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    emitClose(code: closeCode.rawValue, reason: reasonText)
  }

  /// `URLSessionTaskDelegate`'s completion callback: fires exactly once per
  /// task, always last — after `didCloseWith` would already have fired for
  /// a normal close, and after our own `close()` has already reported its
  /// own outcome. If nothing has called `emitClose` by the time this runs
  /// (e.g. the network died with no close frame ever parsed, so
  /// `receive`'s failure branch above had no real code to report), this is
  /// the transport fallback: 1006 "transport". `emitClose`'s lock makes
  /// this a no-op whenever a real close was already reported — this method
  /// never overrides one.
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    emitClose(code: 1006, reason: "transport")
  }

  /// The one pinning decision. During the TLS handshake, takes the
  /// presented leaf certificate's DER bytes, SHA-256s them, hex-encodes
  /// lowercase, and compares to the pinned fingerprint with a
  /// constant-time comparison — equal accepts the connection without
  /// consulting the system trust store, hostname, validity dates or
  /// chain; anything else cancels the handshake. Called once per
  /// connection attempt by the OS.
  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    if matchesPin(trust) {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      emitError("fingerprint mismatch")
      emitClose(code: 1006, reason: "fingerprint")
    }
  }

  private func matchesPin(_ trust: SecTrust) -> Bool {
    guard
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first
    else {
      return false
    }
    let der = SecCertificateCopyData(leaf) as Data
    let digest = SHA256.hash(data: der)
    let actualHex = digest.map { String(format: "%02x", $0) }.joined()

    // Constant-time comparison: every byte is examined, the loop never
    // exits early on a mismatch, so timing cannot leak how many leading
    // hex characters matched.
    guard actualHex.utf8.count == pinnedFingerprintHex.utf8.count else { return false }
    var diff: UInt8 = 0
    for (a, b) in zip(actualHex.utf8, pinnedFingerprintHex.utf8) {
      diff |= a ^ b
    }
    return diff == 0
  }

  private func emitError(_ message: String) {
    onEvent("onError", ["id": id, "message": message])
  }

  private func emitClose(code: Int, reason: String) {
    let (shouldEmit, dropped) = markEmittedAndReadDroppedCount()
    guard shouldEmit else { return }
    if dropped > 0 {
      NSLog("PinnedSocket: dropped %d binary frame(s) on socket %d", dropped, id)
    }
    // `finishTasksAndInvalidate()`, not `invalidateAndCancel()`: the latter
    // cancels outstanding tasks immediately, which can tear the connection
    // down before the close frame `close()` just queued (via
    // `task.cancel(with:reason:)`) is actually written to the socket. The
    // task is already cancelled/closing by the time we get here, so
    // `finishTasksAndInvalidate()` just lets that in-flight work finish —
    // flushing our close frame — before releasing the session's delegate.
    session?.finishTasksAndInvalidate()
    onEvent("onClose", ["id": id, "code": code, "reason": reason])
    onClosed(id)
  }
}
