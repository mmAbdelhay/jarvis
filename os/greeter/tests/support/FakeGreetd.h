#pragma once

#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QLocalServer>
#include <QTemporaryDir>

#include "GreetdCodec.h"

class QLocalSocket;

// An in-process greetd (greetd-ipc(7)) for tests: one PAM-like conversation
// per connection — optional info message, "Password:" secret prompt, optional
// extra visible prompt, then start_session. Socket under /tmp (macOS sun_path).
class FakeGreetd : public QObject {
public:
    FakeGreetd();
    ~FakeGreetd() override;
    bool listen();
    QString socketPath() const;
    void dropClients();

    QHash<QString, QString> passwords{{QStringLiteral("mohamed"), QStringLiteral("right horse")}};
    QString extraPrompt;
    QString extraAnswer;
    QString infoMessage;
    QString startError;
    bool dropOnCreate = false;
    QList<QJsonObject> received;

private:
    enum class Stage { None, Info, Password, Extra, Authed, Failed };
    struct Peer {
        QLocalSocket* socket = nullptr;
        jarvis::greeter::GreetdDecoder decoder;
        QString user;
        Stage stage = Stage::None;
    };
    void onConnection();
    void onData(Peer* peer);
    void handle(Peer* peer, const QJsonObject& request);
    void send(Peer* peer, const QJsonObject& response);
    static QJsonObject success();
    static QJsonObject error(const QString& type, const QString& description);
    static QJsonObject prompt(const QString& type, const QString& text);

    QTemporaryDir m_dir{QStringLiteral("/tmp/jgreetd-XXXXXX")};
    QLocalServer m_server;
    QList<Peer*> m_peers;
};
