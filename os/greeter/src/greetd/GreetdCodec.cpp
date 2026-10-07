#include "GreetdCodec.h"

#include <QJsonDocument>
#include <cstring>

using namespace Qt::StringLiterals;

namespace jarvis::greeter {

QByteArray encodeGreetd(const QJsonObject& message)
{
    const QByteArray payload = QJsonDocument(message).toJson(QJsonDocument::Compact);
    const quint32 length = quint32(payload.size());
    QByteArray frame(sizeof length, Qt::Uninitialized);
    std::memcpy(frame.data(), &length, sizeof length);
    return frame + payload;
}

void GreetdDecoder::feed(const QByteArray& bytes)
{
    if (!failed())
        m_buffer.append(bytes);
}

std::optional<QJsonObject> GreetdDecoder::next()
{
    if (failed() || m_buffer.size() < 4)
        return std::nullopt;
    quint32 length = 0;
    std::memcpy(&length, m_buffer.constData(), sizeof length);
    if (length > quint32(kMaxGreetdMessage)) {
        m_error = u"message too large (%1 bytes)"_s.arg(length);
        return std::nullopt;
    }
    if (m_buffer.size() < 4 + qsizetype(length))
        return std::nullopt;
    const QByteArray payload = m_buffer.mid(4, length);
    m_buffer.remove(0, 4 + qsizetype(length));
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(payload, &parseError);
    if (!doc.isObject()) {
        m_error = u"not a JSON object"_s;
        return std::nullopt;
    }
    return doc.object();
}

} // namespace jarvis::greeter
