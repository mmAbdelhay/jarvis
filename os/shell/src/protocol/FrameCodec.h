#pragma once

// C++ port of packages/desktop/src/daemon/control/frames.ts. Frozen contract:
// every frame is a 5-byte header (payload length, u32 big-endian, then a kind
// byte: 0 JSON, 1 binary) and its payload. next() checks a header's declared
// length against its current limit before waiting for the complete payload.
// push() buffers the supplied chunk, which may contain multiple frames.

#include <QByteArray>
#include <QJsonObject>
#include <optional>
#include <utility>

namespace jarvis::protocol {

inline constexpr int kControlProtocolVersion = 1;
inline constexpr quint32 kMaxControlFrameBytes = 16u * 1024u * 1024u;
inline constexpr quint32 kMaxHelloFrameBytes = 4096u;
inline constexpr qsizetype kFrameHeaderBytes = 5;

enum class FrameKind : quint8 { Json = 0, Binary = 1 };

struct Frame {
    FrameKind kind = FrameKind::Json;
    QJsonObject json; // kind == Json: the shell only ever exchanges objects
    QByteArray bytes; // kind == Binary
};

enum class FrameError { None, UnknownKind, TooLarge, Empty, Malformed };

// Both return an empty QByteArray when the payload exceeds kMaxControlFrameBytes.
QByteArray encodeJsonFrame(const QJsonObject& value);
QByteArray encodeBinaryFrame(const QByteArray& bytes);

class FrameDecoder {
public:
    explicit FrameDecoder(quint32 maxBytes);

    // Checked per frame header, so raising it (after the welcome) applies to the next frame.
    void setMaxBytes(quint32 maxBytes) { m_maxBytes = maxBytes; }
    quint32 maxBytes() const { return m_maxBytes; }
    qsizetype bufferedBytes() const { return m_buffer.size() - m_offset; }

    void push(const QByteArray& chunk);

    // The next complete frame, or nullopt until more bytes arrive. After an
    // error (error() != None) it returns nullopt forever: drop the connection.
    std::optional<Frame> next();
    FrameError error() const { return m_error; }

private:
    std::optional<Frame> fail(FrameError error);
    void compact();

    QByteArray m_buffer;
    qsizetype m_offset = 0;
    quint32 m_maxBytes;
    std::optional<std::pair<quint32, quint8>> m_pending;
    FrameError m_error = FrameError::None;
};

} // namespace jarvis::protocol
