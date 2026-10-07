#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QList>
#include <QObject>

#include "GreetdCodec.h"

class QLocalSocket;

// One connection to greetd at $GREETD_SOCK, opened on demand: requests are
// queued until it is connected; every response arrives through response().
// Any failure drops the connection, so the next send() starts fresh (a greeter
// that outlives a greetd restart keeps working).
class GreetdClient : public QObject {
    Q_OBJECT
public:
    explicit GreetdClient(QString socketPath, QObject* parent = nullptr);
    static QString socketPathFromEnvironment();

    void send(const QJsonObject& request);
    void reset();

signals:
    void response(const QJsonObject& response);
    void failed(const QString& message);

private:
    void flush();
    void onReadyRead();
    void fail(const QString& message);

    QString m_path;
    QLocalSocket* m_socket;
    jarvis::greeter::GreetdDecoder m_decoder;
    QList<QByteArray> m_queue;
    int m_outstanding = 0;
};
