package expo.modules.pinnedsocket

import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

// A fingerprint-pinned WebSocket transport. The module trusts exactly one
// certificate per connection — the leaf whose SHA-256 DER fingerprint the
// caller supplies — never the Android system trust store, never the
// hostname, never the chain or validity dates (ruling: "The phone trusts
// exactly one certificate per pairing", global-constraints.md). No
// `usesCleartextTraffic` and no network security config file: this module
// dials `wss://` only and proves trust itself during the TLS handshake.
class PinnedSocketModule : Module() {
  // The JS thread writes/reads via open/send/close while a network thread
  // (OkHttp's dispatcher) removes an entry on close — ConcurrentHashMap
  // keeps every access thread-safe without an explicit lock.
  private val connections = ConcurrentHashMap<Int, PinnedSocketConnection>()
  private val nextId = AtomicInteger(1)

  override fun definition() = ModuleDefinition {
    Name("PinnedSocket")

    Events("onOpen", "onMessage", "onClose", "onError")

    Function("open") { url: String, fingerprintHex: String ->
      val id = nextId.getAndIncrement()
      val connection = PinnedSocketConnection(
        id = id,
        pinnedFingerprintHex = fingerprintHex.lowercase(),
        onEvent = { name, body -> sendEvent(name, body) },
        onClosed = { closedId -> connections.remove(closedId) },
      )
      connections[id] = connection
      connection.connect(url)
      id
    }

    Function("send") { id: Int, text: String ->
      connections[id]?.send(text)
    }

    Function("sendBinary") { id: Int, base64: String ->
      connections[id]?.sendBinary(base64)
    }

    Function("close") { id: Int, code: Int, reason: String ->
      connections[id]?.close(code, reason)
    }
  }
}

/**
 * A [X509TrustManager] that trusts exactly one certificate — the leaf whose
 * SHA-256 DER fingerprint matches [pinnedFingerprintHex] — and nothing
 * else. This is the module's one pinning decision.
 */
private class PinnedTrustManager(private val pinnedFingerprintHex: String) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {
    throw CertificateException("client certificates are not accepted")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
    val leaf = chain.firstOrNull()
      ?: throw CertificateException("fingerprint mismatch")
    val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
    val actualHex = digest.joinToString("") { "%02x".format(it) }

    // MessageDigest.isEqual is a documented constant-time comparison: it
    // always walks every byte of both arrays rather than returning as soon
    // as one differs, so timing cannot leak how many leading hex
    // characters matched. Compared as ASCII bytes, not as the hex strings
    // themselves, to keep the comparison length fixed regardless of case.
    val actual = actualHex.toByteArray(Charsets.US_ASCII)
    val pinned = pinnedFingerprintHex.toByteArray(Charsets.US_ASCII)
    if (!MessageDigest.isEqual(actual, pinned)) {
      throw CertificateException("fingerprint mismatch")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * Hostname verification is intentionally bypassed: the leaf-certificate pin
 * in [PinnedTrustManager] is the entire trust decision. The laptop's
 * self-signed certificate has no hostname a normal verifier could check
 * (LAN IP literals, no CA), and the constant-time fingerprint comparison
 * above already proves this is the one certificate the phone was told to
 * trust — a wider hostname check would add nothing.
 */
private val TRUST_ALL_HOSTNAMES = HostnameVerifier { _, _ -> true }

/** One pinned WebSocket connection. Owns its own [OkHttpClient] (one per
 * socket, not shared) so a mismatched pin on one connection can never
 * affect another's cached state. */
private class PinnedSocketConnection(
  private val id: Int,
  private val pinnedFingerprintHex: String,
  private val onEvent: (String, Map<String, Any?>) -> Unit,
  private val onClosed: (Int) -> Unit,
) : WebSocketListener() {
  private var client: OkHttpClient? = null
  private var socket: WebSocket? = null

  // Read/written from both the JS thread (send/close) and OkHttp's
  // dispatcher threads (onOpen/onMessage/onClosed/onFailure) — Atomic
  // types keep every access thread-safe without an explicit lock.
  private val didEmitClose = AtomicBoolean(false)
  private val binaryFramesDropped = AtomicInteger(0)

  fun connect(url: String) {
    // M7 Task 3 / ruling 9: iOS raises `maximumMessageSize` to 16 MiB
    // (PINNED_SOCKET_MAX_MESSAGE_BYTES, PinnedSocketModule.swift) because
    // URLSession defaults to 1 MiB. OkHttp 4.9.2's WebSocket implementation
    // (RealWebSocket/WebSocketReader) has no configurable inbound message
    // size limit — an incoming message is assembled in memory with no cap
    // other than available heap — so there is nothing to set here.
    val trustManager = PinnedTrustManager(pinnedFingerprintHex)
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf(trustManager), SecureRandom())

    val client = OkHttpClient.Builder()
      .sslSocketFactory(sslContext.socketFactory, trustManager)
      .hostnameVerifier(TRUST_ALL_HOSTNAMES)
      .build()
    this.client = client

    val request = try {
      Request.Builder().url(url).build()
    } catch (e: IllegalArgumentException) {
      // Never throw across the bridge, and never emit synchronously inside
      // `open()`/`connect()`: the caller (native-transport.ts) only
      // registers its event route after the native `open` call returns the
      // socket id, so an event fired from within this call would be
      // dropped. Post to the main looper to defer past that return.
      Handler(Looper.getMainLooper()).post {
        onEvent("onError", mapOf("id" to id, "message" to "invalid url"))
        emitClose(1006, "transport")
      }
      return
    }
    socket = client.newWebSocket(request, this)
  }

  fun send(text: String) {
    if (didEmitClose.get()) return
    socket?.send(text)
  }

  /** Sends one binary WebSocket frame (M8 ruling 1/2: the blob upload
   * lane). [base64] is decoded to raw bytes here, natively — it never
   * touches JS as anything but a string, and never touches JSON. */
  fun sendBinary(base64: String) {
    if (didEmitClose.get()) return
    // OkHttp fails a send once its outgoing queue exceeds 16 MiB combined
    // (RealWebSocket's internal queue-size cap). Voice uploads are bounded
    // by MAX_VOICE_BYTES (4 MiB), well under that ceiling; a later, larger
    // blob lane (M9's file upload) must pace its own chunk sends rather
    // than firing every chunk synchronously the way this method does.
    // okio 2.8.0 (pulled in by okhttp 4.9.2, build.gradle:28) declares
    // decodeBase64 as a member extension on ByteString.Companion — imported
    // above and called with a String receiver. Returns null for input
    // that isn't valid base64.
    val bytes = base64.decodeBase64()
    val sent = bytes != null && (socket?.send(bytes) ?: false)
    if (!sent) {
      // Neither a locally undecodable payload nor a send() that merely
      // returned false (queue full, or the socket already closing)
      // produces any later OkHttp callback to rely on — unlike onFailure()
      // below, which reports genuine connection death. Report it
      // ourselves, the same way close() already does for a self-initiated
      // close: an error, a cancel to free the socket (mirrors iOS's
      // task.cancel() — otherwise a null-decode leaves a live WebSocket
      // orphaned until the laptop's heartbeat eventually kills it), then
      // emitClose directly, so "an error is always followed by close"
      // holds without waiting on a callback that will never fire.
      onEvent("onError", mapOf("id" to id, "message" to "send failed"))
      socket?.cancel()
      emitClose(1006, "transport")
    }
  }

  fun close(code: Int, reason: String) {
    if (didEmitClose.get()) return
    // OkHttp's WebSocket.close throws IllegalArgumentException for a code
    // outside 1000 or 3000-4999, or a reason over 123 UTF-8 bytes — never
    // throw across the bridge.
    val safeCode = if (code == 1000 || code in 3000..4999) code else 1000
    val safeReason = clampReason(reason)
    try {
      socket?.close(safeCode, safeReason)
    } catch (e: IllegalArgumentException) {
      // Should not happen given the clamp above; guard anyway.
    }
  }

  private fun clampReason(reason: String): String {
    var candidate = reason
    // M12 Task 8 (M6 N5, deferred): `dropLast(1)` removed one UTF-16 code
    // unit at a time, which can split a surrogate pair (any character
    // outside the BMP) and leave a lone, unpaired surrogate behind — drop
    // by whole Unicode code point instead, the same "never emit a partial
    // character" guarantee the Swift side's Character-based clampReason
    // already has. Worst case (a single code point whose UTF-8 encoding
    // alone exceeds 123 bytes) empties the string rather than looping
    // forever.
    while (candidate.isNotEmpty() && candidate.toByteArray(Charsets.UTF_8).size > 123) {
      val lastCodePointStart = candidate.offsetByCodePoints(candidate.length, -1)
      candidate = candidate.substring(0, lastCodePointStart)
    }
    return candidate
  }

  override fun onOpen(webSocket: WebSocket, response: Response) {
    onEvent("onOpen", mapOf("id" to id))
  }

  override fun onMessage(webSocket: WebSocket, text: String) {
    onEvent("onMessage", mapOf("id" to id, "text" to text))
  }

  override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
    // Text frames only (behaviour rule 4): a binary frame is dropped, never
    // delivered, and only its count is ever logged (once, at close).
    binaryFramesDropped.incrementAndGet()
  }

  // Close-timing difference from iOS (see PinnedSocketModule.swift): OkHttp
  // only calls onClosed() once the peer has acknowledged our close frame
  // with its own (or, if the peer never responds, after OkHttp's internal
  // 60s cancel fires onFailure() with 1006). Android's onClose therefore
  // lands later than iOS's, which reports its own close immediately on
  // `close()` without waiting for any acknowledgement.
  override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
    emitClose(code, reason)
  }

  override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
    webSocket.close(code, reason)
  }

  override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
    // M12 Task 8 (M8 T5-a, deferred): a self-initiated close (e.g. the
    // null-decode branch's socket?.cancel() above) makes OkHttp's reader
    // thread surface the cancelled call here as onFailure too, after this
    // module's own onClose already fired — harmless (native-transport.ts
    // drops any post-close event for this id) but this guard makes the
    // self-initiated path emit exactly one onError natively, same as a
    // genuine first-time transport failure.
    if (didEmitClose.get()) return
    // A handshake failure caused by the pinned trust manager rejecting the
    // certificate surfaces here wrapped in an SSLHandshakeException, with
    // PinnedTrustManager's CertificateException somewhere in the cause
    // chain. Any other TLS/network failure (protocol mismatch, a
    // non-TLS server, a dropped connection) must not be reported as a
    // pin mismatch. Neither message ever carries either fingerprint.
    val isPinMismatch = generateSequence(t) { it.cause }.any { it is CertificateException }
    val message = if (isPinMismatch) "fingerprint mismatch" else "transport"
    val closeReason = if (isPinMismatch) "fingerprint" else "transport"
    onEvent("onError", mapOf("id" to id, "message" to message))
    emitClose(1006, closeReason)
  }

  private fun emitClose(code: Int, reason: String) {
    if (!didEmitClose.compareAndSet(false, true)) return
    val dropped = binaryFramesDropped.get()
    if (dropped > 0) {
      Log.d("PinnedSocket", "dropped $dropped binary frame(s) on socket $id")
    }
    client?.dispatcher?.executorService?.shutdown()
    onEvent("onClose", mapOf("id" to id, "code" to code, "reason" to reason))
    onClosed(id)
  }
}
