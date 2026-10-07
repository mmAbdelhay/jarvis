#pragma once

// The shell's end of jarvisd's control transport: a C++ port of
// packages/desktop/src/daemon/control/client.ts (hello → challenge → auth →
// welcome, then req/res/err/psh), plus what the shell needs on top: it
// reconnects forever with backoff (jarvisd is a systemd user unit that may
// start after the shell or restart under it) and emits opened() after every
// welcome so the shell can resync. The secret is re-read on every attempt,
// never sent, logged or put in an error message.

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QTimer>
#include <functional>

#include "protocol/FrameCodec.h"

class QLocalSocket;

struct ControlResult {
    bool ok = false;
    QJsonValue value; // the `v` of a res
    QString code;     // wire error code, or "closed" when there is no open connection
    QString text;
};
using ControlReply = std::function<void(const ControlResult&)>;

struct ControlOptions {
    QString socketPath;
    QString secretPath;
    QString build = QStringLiteral("dev");
    int handshakeTimeoutMs = 5000; // HANDSHAKE_TIMEOUT_MS in @jarvis/wire
    QList<int> backoffMs{250, 500, 1000, 2000, 4000, 5000};
    std::function<QByteArray(int)> randomBytes; // default: QRandomGenerator::system()
};

int backoffDelay(const QList<int>& steps, int attempt);

class ControlClient : public QObject {
    Q_OBJECT
    Q_PROPERTY(State state READ state NOTIFY stateChanged)
    Q_PROPERTY(QString lastError READ lastError NOTIFY stateChanged)

public:
    enum class State { Idle, Connecting, Open, Waiting };
    Q_ENUM(State)

    explicit ControlClient(ControlOptions options, QObject* parent = nullptr);
    ~ControlClient() override;

    State state() const { return m_state; }
    QString lastError() const { return m_lastError; }
    QString build() const { return m_build; }

    void start(); // connect now; reconnect with backoff whenever the connection drops
    void stop();  // close for good; pending replies fail with code "closed"

    // Requests are never queued across a reconnect (re-sending agent:prompt or
    // agent:confirm could act twice): without an open connection the reply is
    // {ok:false, code:"closed"}, delivered asynchronously.
    void invoke(const QString& channel, const QJsonArray& args, ControlReply reply = {});

signals:
    void stateChanged();
    void opened();
    void closed();
    void push(const QString& channel, const QJsonValue& payload);

private:
    enum class Phase { None, Hello, Auth, Open };

    void attempt();
    void onConnected();
    void onReadyRead();
    void onFrame(const QJsonObject& message);
    void dropConnection(const QString& reason);
    void scheduleReconnect(int delayMs);
    void setState(State state);
    void send(const QJsonObject& message);
    void failPending(const QString& text);

    ControlOptions m_options;
    QString m_build;
    State m_state = State::Idle;
    Phase m_phase = Phase::None;
    QString m_lastError;
    bool m_running = false;
    bool m_retryNow = false;
    int m_attempt = 0;
    QLocalSocket* m_socket = nullptr;
    jarvis::protocol::FrameDecoder m_decoder{jarvis::protocol::kMaxHelloFrameBytes};
    QByteArray m_secret;
    QByteArray m_nonceC;
    QTimer m_handshakeTimer;
    QTimer m_reconnectTimer;
    quint64 m_nextId = 1;
    QHash<quint64, ControlReply> m_pending;
};
