#pragma once

#include <QLocalServer>
#include <QObject>

// One shell per session. The compositor's Super keybind runs
// `jarvis-shell --focus`; that second process hands "focus" to the running
// shell over a per-user local socket and exits.
class SingleInstance : public QObject {
    Q_OBJECT
public:
    explicit SingleInstance(QString name, QObject* parent = nullptr);

    // $XDG_RUNTIME_DIR/jarvis-shell.sock, else <tmp>/jarvis-shell-<uid>.sock.
    static QString nameFor(const QString& base);
    static QString defaultName();

    // True when a running shell accepted the message.
    bool forward(const QByteArray& message, int timeoutMs = 500);
    bool listen();

signals:
    void messageReceived(const QByteArray& message);

private:
    QString m_name;
    QLocalServer m_server;
};
