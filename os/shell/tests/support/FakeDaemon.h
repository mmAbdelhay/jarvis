#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QLocalServer>
#include <QTemporaryDir>
#include <functional>

#include "protocol/FrameCodec.h"

class QLocalSocket;

// An in-process stand-in for jarvisd's control server (server.ts) for unit
// tests: same frames, same proofs, configurable misbehaviour. Lives under
// /tmp so the socket path stays below macOS's 104-byte sun_path limit.
class FakeDaemon : public QObject {
public:
    struct Reply {
        bool ok = true;
        QJsonValue value;
        QString code;
        QString text;
        bool defer = false; // answer later with respond()
    };
    using Handler = std::function<Reply(const QString& channel, const QJsonArray& args, quint64 id)>;

    FakeDaemon();
    ~FakeDaemon() override;

    bool listen();
    QString socketPath() const;
    QString secretPath() const;

    QString build = QStringLiteral("dev"); // restart-required unless hello.build matches
    bool wrongProof = false;               // send a challenge whose proof is wrong
    bool silent = false;                   // never answer the hello
    QByteArray rawChallenge;               // when set, sent verbatim instead of a challenge
    Handler handler;                       // default: {t:"res", v:null}

    QList<QJsonObject> received; // every JSON frame from every client, in order
    int hellos = 0;
    int welcomes = 0;

    QList<QJsonObject> requests(const QString& channel) const;
    void sendPush(const QString& channel, const QJsonValue& payload);
    void respond(quint64 id, const QJsonValue& value);
    void dropClients();
    int openClients() const;

private:
    struct Peer {
        QLocalSocket* socket = nullptr;
        jarvis::protocol::FrameDecoder decoder{jarvis::protocol::kMaxHelloFrameBytes};
        QByteArray nonceC;
        QByteArray nonceS;
        QString helloBuild;
        enum class Phase { Hello, Auth, Open } phase = Phase::Hello;
    };

    void onConnection();
    void onData(Peer* peer);
    void sendTo(Peer* peer, const QJsonObject& message);
    void forget(Peer* peer);

    QTemporaryDir m_dir;
    QLocalServer m_server;
    QByteArray m_secret;
    QList<Peer*> m_peers;
    quint64 m_seq = 0;
};
