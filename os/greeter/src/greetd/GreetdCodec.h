#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QString>
#include <optional>

// greetd IPC framing (greetd-ipc(7)): a 32-bit length in the host's byte
// order, then that many bytes of UTF-8 JSON.
namespace jarvis::greeter {

inline constexpr qsizetype kMaxGreetdMessage = 64 * 1024;

QByteArray encodeGreetd(const QJsonObject& message);

class GreetdDecoder {
public:
    void feed(const QByteArray& bytes);
    std::optional<QJsonObject> next(); // nullopt: need more bytes, or failed()
    bool failed() const { return !m_error.isEmpty(); }
    QString error() const { return m_error; }

private:
    QByteArray m_buffer;
    QString m_error;
};

} // namespace jarvis::greeter
