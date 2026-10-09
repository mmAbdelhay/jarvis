#pragma once

// C++ port of packages/desktop/src/daemon/control/handshake.ts — mutual
// HMAC-SHA256 challenge-response, server first:
//   client → {t:"hello", v, build, nonceC}
//   server → {t:"challenge", nonceS, proof: HMAC(secret, "jarvisd-server"‖nonceC‖nonceS)}
//   client → {t:"auth", proof: HMAC(secret, "jarvisd-client"‖nonceS‖nonceC)}
//   server → {t:"welcome", v, capabilities} | {t:"restart-required", build}
// The HMAC covers the raw 32-byte nonces; the wire carries lowercase hex.

#include <QByteArray>
#include <QString>
#include <optional>

namespace jarvis::protocol {

inline constexpr int kNonceBytes = 32;

QByteArray serverProof(const QByteArray& secret, const QByteArray& nonceC, const QByteArray& nonceS);
QByteArray clientProof(const QByteArray& secret, const QByteArray& nonceS, const QByteArray& nonceC);

// 32 bytes as lowercase hex: nonces, proofs and the secret file alike (HEX32_PATTERN).
bool isHex32(QStringView text);

// Constant time; a malformed `givenHex` is simply a mismatch.
bool proofMatches(const QByteArray& expected, QStringView givenHex);

// The control.secret file's content, trimmed, as 32 raw bytes; nullopt when malformed.
std::optional<QByteArray> parseSecret(const QByteArray& fileContent);

} // namespace jarvis::protocol
