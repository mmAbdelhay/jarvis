#include "control/ControlClient.h"

#include <QFile>
#include <QLocalSocket>
#include <QRandomGenerator>
#include <algorithm>
#include <cmath>
#include <utility>

#include "protocol/BuildId.h"
#include "protocol/Handshake.h"

using namespace jarvis::protocol;
using namespace Qt::StringLiterals;

namespace {

const QStringList kRemoteErrorCodes{u"bad-request"_s, u"unknown-channel"_s, u"forbidden"_s, u"internal"_s,
                                    u"rate-limited"_s, u"unsupported"_s, u"locked"_s};

bool isId(const QJsonValue& value)
{
    if (!value.isDouble())
        return false;
    const double d = value.toDouble();
    return d >= 0 && d <= 9007199254740991.0 && std::floor(d) == d;
}

bool isChannel(const QJsonValue& value)
{
    return value.isString() && !value.toString().isEmpty() && value.toString().size() <= 128;
}

QByteArray systemRandom(int count)
{
    QByteArray out;
    out.reserve(count);
    while (out.size() < count) {
        const quint32 word = QRandomGenerator::system()->generate();
        out.append(reinterpret_cast<const char*>(&word), std::min<qsizetype>(4, count - out.size()));
    }
    return out;
}

} // namespace

int backoffDelay(const QList<int>& steps, int attempt)
{
    if (steps.isEmpty())
        return 1000;
    return steps[std::clamp(attempt, 0, int(steps.size()) - 1)];
}

ControlClient::ControlClient(ControlOptions options, QObject* parent)
    : QObject(parent)
    , m_options(std::move(options))
    , m_build(m_options.build)
{
    if (!m_options.randomBytes)
        m_options.randomBytes = systemRandom;
    m_handshakeTimer.setSingleShot(true);
    connect(&m_handshakeTimer, &QTimer::timeout, this,
            [this] { dropConnection(u"The Jarvis daemon did not answer the control handshake"_s); });
    m_reconnectTimer.setSingleShot(true);
    connect(&m_reconnectTimer, &QTimer::timeout, this, &ControlClient::attempt);
}

ControlClient::~ControlClient()
{
    m_running = false;
    if (m_socket) {
        m_socket->disconnect(this);
        m_socket->abort();
    }
}

void ControlClient::setState(State state)
{
    m_state = state;
    emit stateChanged(); // also carries lastError changes
}

void ControlClient::start()
{
    if (m_running)
        return;
    m_running = true;
    m_attempt = 0;
    attempt();
}

void ControlClient::stop()
{
    m_running = false;
    m_reconnectTimer.stop();
    dropConnection({});
    setState(State::Idle);
}

void ControlClient::attempt()
{
    if (!m_running || m_socket)
        return;
    setState(State::Connecting);
    // Re-read every time: a restarted daemon writes a fresh secret.
    QFile secretFile(m_options.secretPath);
    std::optional<QByteArray> secret;
    if (secretFile.open(QIODevice::ReadOnly))
        secret = parseSecret(secretFile.read(4096));
    if (!secret) {
        m_lastError = secretFile.exists() ? u"The control secret file is malformed"_s
                                          : u"jarvisd is not running (no control secret yet)"_s;
        scheduleReconnect(backoffDelay(m_options.backoffMs, m_attempt++));
        return;
    }
    m_secret = *secret;
    m_nonceC = m_options.randomBytes(kNonceBytes);
    m_decoder = FrameDecoder(kMaxHelloFrameBytes); // hello-sized until the welcome
    m_phase = Phase::Hello;
    m_socket = new QLocalSocket(this);
    connect(m_socket, &QLocalSocket::connected, this, &ControlClient::onConnected);
    connect(m_socket, &QLocalSocket::readyRead, this, &ControlClient::onReadyRead);
    connect(m_socket, &QLocalSocket::disconnected, this,
            [this] { dropConnection(u"The Jarvis daemon closed the control connection"_s); });
    connect(m_socket, &QLocalSocket::errorOccurred, this, [this](QLocalSocket::LocalSocketError) {
        dropConnection(m_socket ? m_socket->errorString() : QString());
    });
    m_handshakeTimer.start(m_options.handshakeTimeoutMs);
    m_socket->connectToServer(m_options.socketPath);
}

void ControlClient::onConnected()
{
    send({{"t", "hello"},
          {"v", kControlProtocolVersion},
          {"build", m_build},
          {"nonceC", QString::fromLatin1(m_nonceC.toHex())}});
}

void ControlClient::send(const QJsonObject& message)
{
    if (!m_socket)
        return;
    const QByteArray frame = encodeJsonFrame(message);
    if (frame.isEmpty())
        return dropConnection(u"A control request was too large to send"_s);
    m_socket->write(frame);
}

void ControlClient::onReadyRead()
{
    if (!m_socket)
        return;
    m_decoder.push(m_socket->readAll());
    while (m_socket) {
        const auto frame = m_decoder.next();
        if (!frame) {
            if (m_decoder.error() != FrameError::None)
                dropConnection(u"Bad control frame"_s);
            return;
        }
        if (frame->kind != FrameKind::Json)
            return dropConnection(u"Unexpected binary control frame"_s);
        onFrame(frame->json);
    }
}

void ControlClient::onFrame(const QJsonObject& m)
{
    const QString t = m.value("t").toString();
    switch (m_phase) {
    case Phase::Hello: {
        const QString nonceS = m.value("nonceS").toString();
        const QString proof = m.value("proof").toString();
        if (t != u"challenge" || !isHex32(nonceS) || !isHex32(proof))
            return dropConnection(u"Expected a control challenge"_s);
        const QByteArray nonceSBytes = QByteArray::fromHex(nonceS.toLatin1());
        if (!proofMatches(serverProof(m_secret, m_nonceC, nonceSBytes), proof))
            return dropConnection(u"The control endpoint did not prove it is the Jarvis daemon"_s);
        m_phase = Phase::Auth;
        send({{"t", "auth"}, {"proof", QString::fromLatin1(clientProof(m_secret, nonceSBytes, m_nonceC).toHex())}});
        return;
    }
    case Phase::Auth: {
        if (t == u"welcome") {
            const QJsonValue capabilities = m.value("capabilities");
            if (!isId(m.value("v")) || !capabilities.isArray())
                return dropConnection(u"Malformed control welcome"_s);
            for (const QJsonValue& capability : capabilities.toArray())
                if (!capability.isString())
                    return dropConnection(u"Malformed control welcome"_s);
            m_handshakeTimer.stop();
            m_phase = Phase::Open;
            m_decoder.setMaxBytes(kMaxControlFrameBytes);
            m_attempt = 0;
            m_lastError.clear();
            setState(State::Open);
            emit opened();
            return;
        }
        if (t == u"restart-required") {
            const QJsonValue build = m.value("build");
            if (!build.isString() || build.toString().size() > kMaxBuildLength)
                return dropConnection(u"Malformed restart-required"_s);
            // systemd owns jarvisd, so the shell does not restart it: it adopts
            // the daemon's build and reconnects at once. The same build being
            // refused again means the protocol version differs: back off.
            if (build.toString() == m_build)
                return dropConnection(u"jarvisd speaks another control protocol version"_s);
            m_build = build.toString();
            m_retryNow = true;
            return dropConnection(u"jarvisd runs build %1; reconnecting with it"_s.arg(m_build));
        }
        return dropConnection(u"Unexpected control frame before welcome"_s);
    }
    case Phase::Open: {
        if (t == u"psh") {
            if (!isChannel(m.value("ch")) || !isId(m.value("seq")))
                return dropConnection(u"Malformed control push"_s);
            emit push(m.value("ch").toString(), m.value("p"));
            return;
        }
        if (t == u"res" || t == u"err") {
            if (!isId(m.value("id")))
                return dropConnection(u"Malformed control reply"_s);
            ControlResult result;
            if (t == u"res") {
                result.ok = true;
                result.value = m.value("v");
            } else {
                const QString code = m.value("code").toString();
                if (!kRemoteErrorCodes.contains(code) || !m.value("text").isString())
                    return dropConnection(u"Malformed control error"_s);
                result.code = code;
                result.text = m.value("text").toString();
            }
            const ControlReply reply = m_pending.take(quint64(m.value("id").toDouble()));
            if (reply)
                reply(result);
            return;
        }
        return dropConnection(u"Unexpected control frame"_s);
    }
    case Phase::None:
        return;
    }
}

void ControlClient::invoke(const QString& channel, const QJsonArray& args, ControlReply reply)
{
    if (m_phase != Phase::Open || !m_socket) {
        if (reply)
            QTimer::singleShot(0, this, [reply] {
                reply({false, {}, u"closed"_s, u"Not connected to jarvisd"_s});
            });
        return;
    }
    const quint64 id = m_nextId++;
    m_pending.insert(id, std::move(reply));
    send({{"t", "req"}, {"id", qint64(id)}, {"ch", channel}, {"a", args}});
}

void ControlClient::upload(const QString& channel, const QJsonArray& args, const QByteArray& bytes, ControlReply reply)
{
    const auto failSoon = [this, &reply](const QString& code, const QString& text) {
        if (reply)
            QTimer::singleShot(0, this, [reply, code, text] { reply({false, {}, code, text}); });
    };
    if (bytes.isEmpty() || bytes.size() > kMaxBlobBytes)
        return failSoon(u"bad-request"_s, u"Upload size is out of range"_s);
    if (m_phase != Phase::Open || !m_socket)
        return failSoon(u"closed"_s, u"Not connected to jarvisd"_s);
    const qsizetype chunks = (bytes.size() + kMaxBlobChunkBytes - 1) / kMaxBlobChunkBytes;
    const quint64 id = m_nextId++;
    m_pending.insert(id, std::move(reply));
    send({{"t", "blob"}, {"id", qint64(id)}, {"ch", channel}, {"a", args},
          {"bytes", qint64(bytes.size())}, {"chunks", qint64(chunks)}});
    for (qsizetype offset = 0; offset < bytes.size() && m_socket; offset += kMaxBlobChunkBytes)
        m_socket->write(encodeBinaryFrame(bytes.mid(offset, kMaxBlobChunkBytes)));
}

void ControlClient::failPending(const QString& text)
{
    const auto pending = std::exchange(m_pending, {});
    for (const ControlReply& reply : pending)
        if (reply)
            reply({false, {}, u"closed"_s, text});
}

void ControlClient::dropConnection(const QString& reason)
{
    m_handshakeTimer.stop();
    if (!m_socket)
        return; // already dropped: the first reason stands
    QLocalSocket* socket = std::exchange(m_socket, nullptr);
    socket->disconnect(this);
    socket->abort();
    socket->deleteLater();
    const bool wasOpen = m_phase == Phase::Open;
    m_phase = Phase::None;
    m_secret.fill('\0');
    m_secret.clear();
    if (!reason.isEmpty())
        m_lastError = reason;
    if (wasOpen) {
        failPending(u"The control connection closed"_s);
        emit closed();
    }
    if (!m_running)
        return;
    if (std::exchange(m_retryNow, false))
        scheduleReconnect(0);
    else
        scheduleReconnect(backoffDelay(m_options.backoffMs, m_attempt++));
}

void ControlClient::scheduleReconnect(int delayMs)
{
    setState(State::Waiting);
    m_reconnectTimer.start(delayMs);
}
