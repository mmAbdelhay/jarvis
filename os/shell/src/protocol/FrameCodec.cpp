#include "protocol/FrameCodec.h"

#include <QJsonDocument>
#include <QJsonParseError>
#include <QtEndian>

namespace jarvis::protocol {
namespace {

QByteArray header(quint32 length, FrameKind kind)
{
    QByteArray out(kFrameHeaderBytes, Qt::Uninitialized);
    qToBigEndian<quint32>(length, out.data());
    out[4] = static_cast<char>(kind);
    return out;
}

} // namespace

QByteArray encodeJsonFrame(const QJsonObject& value)
{
    const QByteArray payload = QJsonDocument(value).toJson(QJsonDocument::Compact);
    if (payload.size() > qsizetype(kMaxControlFrameBytes))
        return {};
    return header(quint32(payload.size()), FrameKind::Json) + payload;
}

QByteArray encodeBinaryFrame(const QByteArray& bytes)
{
    if (bytes.size() > qsizetype(kMaxControlFrameBytes))
        return {};
    return header(quint32(bytes.size()), FrameKind::Binary) + bytes;
}

FrameDecoder::FrameDecoder(quint32 maxBytes)
    : m_maxBytes(maxBytes)
{
}

void FrameDecoder::push(const QByteArray& chunk)
{
    if (chunk.isEmpty() || m_error != FrameError::None)
        return;
    m_buffer.append(chunk);
}

std::optional<Frame> FrameDecoder::fail(FrameError error)
{
    m_error = error;
    m_buffer.clear();
    m_offset = 0;
    m_pending.reset();
    return std::nullopt;
}

void FrameDecoder::compact()
{
    if (m_offset == m_buffer.size()) {
        m_buffer.clear();
        m_offset = 0;
    } else if (m_offset >= 64 * 1024) {
        m_buffer.remove(0, m_offset);
        m_offset = 0;
    }
}

std::optional<Frame> FrameDecoder::next()
{
    if (m_error != FrameError::None)
        return std::nullopt;
    if (!m_pending) {
        if (bufferedBytes() < kFrameHeaderBytes)
            return std::nullopt;
        const auto* head = reinterpret_cast<const uchar*>(m_buffer.constData() + m_offset);
        const quint32 length = qFromBigEndian<quint32>(head);
        const quint8 kind = head[4];
        m_offset += kFrameHeaderBytes;
        if (kind != quint8(FrameKind::Json) && kind != quint8(FrameKind::Binary))
            return fail(FrameError::UnknownKind);
        if (length > m_maxBytes)
            return fail(FrameError::TooLarge);
        if (kind == quint8(FrameKind::Json) && length == 0)
            return fail(FrameError::Empty);
        m_pending = std::make_pair(length, kind);
        compact();
    }
    if (bufferedBytes() < qsizetype(m_pending->first))
        return std::nullopt;
    const auto [length, kind] = *m_pending;
    m_pending.reset();
    const QByteArray payload = m_buffer.mid(m_offset, length);
    m_offset += length;
    compact();
    if (kind == quint8(FrameKind::Binary))
        return Frame{FrameKind::Binary, {}, payload};
    QJsonParseError parseError{};
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject())
        return fail(FrameError::Malformed);
    return Frame{FrameKind::Json, document.object(), {}};
}

} // namespace jarvis::protocol
