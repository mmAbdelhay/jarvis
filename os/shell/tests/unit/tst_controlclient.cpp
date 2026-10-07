#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>
#include <algorithm>

#include "FakeDaemon.h"
#include "control/ControlClient.h"

using namespace Qt::StringLiterals;

namespace {
ControlOptions optionsFor(const FakeDaemon& daemon)
{
    ControlOptions options;
    options.socketPath = daemon.socketPath();
    options.secretPath = daemon.secretPath();
    options.handshakeTimeoutMs = 400;
    options.backoffMs = {20};
    options.randomBytes = [](int count) { return QByteArray(count, '\x22'); };
    return options;
}

FakeDaemon::Reply deferred()
{
    FakeDaemon::Reply reply;
    reply.defer = true;
    return reply;
}
} // namespace

class TestControlClient : public QObject {
    Q_OBJECT
private slots:
    void opensWithAHelloAndAnAuth()
    {
        FakeDaemon daemon;
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        client.start();
        QVERIFY(opened.wait(2000));
        QCOMPARE(client.state(), ControlClient::State::Open);
        const QJsonObject hello = daemon.received.at(0);
        QCOMPARE(hello["t"].toString(), u"hello"_s);
        QCOMPARE(hello["v"].toInt(), 1);
        QCOMPARE(hello["build"].toString(), u"dev"_s);
        QCOMPARE(hello["nonceC"].toString(), QString(64, u'2'));
        QVERIFY(!hello.contains("intent"));
        QCOMPARE(daemon.received.at(1)["t"].toString(), u"auth"_s);
    }

    void refusesADaemonThatCannotProveItself()
    {
        FakeDaemon daemon;
        daemon.wrongProof = true;
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        client.start();
        QTRY_VERIFY(client.lastError().contains(u"did not prove"_s));
        QVERIFY(client.state() != ControlClient::State::Open);
        QVERIFY(std::none_of(daemon.received.cbegin(), daemon.received.cend(),
                             [](const QJsonObject& m) { return m["t"].toString() == u"auth"; }));
    }

    void adoptsTheDaemonBuildOnRestartRequired()
    {
        FakeDaemon daemon;
        daemon.build = u"0.4.0+abc.2026-10-07T10:00:00.000Z"_s;
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        client.start();
        QVERIFY(opened.wait(2000));
        QCOMPARE(client.build(), daemon.build);
        QCOMPARE(daemon.hellos, 2);
    }

    void correlatesRepliesOutOfOrder()
    {
        FakeDaemon daemon;
        QList<quint64> ids;
        daemon.handler = [&](const QString&, const QJsonArray&, quint64 id) {
            ids.append(id);
            return deferred();
        };
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        client.start();
        QVERIFY(opened.wait(2000));
        QString first, second;
        client.invoke(u"a:one"_s, {}, [&](const ControlResult& r) { first = r.value.toString(); });
        client.invoke(u"a:two"_s, {}, [&](const ControlResult& r) { second = r.value.toString(); });
        QTRY_COMPARE(ids.size(), 2);
        daemon.respond(ids[1], u"two"_s);
        daemon.respond(ids[0], u"one"_s);
        QTRY_COMPARE(first, u"one"_s);
        QCOMPARE(second, u"two"_s);
        const QJsonObject req = daemon.requests(u"a:one"_s).first();
        QCOMPARE(req["a"].toArray(), QJsonArray());
    }

    void reportsServerErrors()
    {
        FakeDaemon daemon;
        daemon.handler = [](const QString&, const QJsonArray&, quint64) {
            return FakeDaemon::Reply{false, {}, u"unsupported"_s, u"nope"_s};
        };
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        client.start();
        QVERIFY(opened.wait(2000));
        std::optional<ControlResult> result;
        client.invoke(u"x:y"_s, {}, [&](const ControlResult& r) { result = r; });
        QTRY_VERIFY(result.has_value());
        QVERIFY(!result->ok);
        QCOMPARE(result->code, u"unsupported"_s);
        QCOMPARE(result->text, u"nope"_s);
    }

    void dispatchesPushes()
    {
        FakeDaemon daemon;
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        QSignalSpy pushes(&client, &ControlClient::push);
        client.start();
        QVERIFY(opened.wait(2000));
        daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", false}, {"error", "timeout"}});
        QTRY_COMPARE(pushes.size(), 1);
        QCOMPARE(pushes[0][0].toString(), u"provider:status"_s);
        QCOMPARE(pushes[0][1].value<QJsonValue>()["error"].toString(), u"timeout"_s);
    }

    void invokeWhileClosedFailsFast()
    {
        ControlOptions options;
        options.socketPath = u"/tmp/jsh-nowhere/jarvisd.sock"_s;
        options.secretPath = u"/tmp/jsh-nowhere/control.secret"_s;
        ControlClient client(options);
        std::optional<ControlResult> result;
        client.invoke(u"agent:prompt"_s, {QJsonObject{{"text", "hi"}}}, [&](const ControlResult& r) { result = r; });
        QTRY_VERIFY(result.has_value());
        QCOMPARE(result->code, u"closed"_s);
    }

    void reconnectsAndResyncsAfterTheDaemonDrops()
    {
        FakeDaemon daemon;
        daemon.handler = [](const QString&, const QJsonArray&, quint64) { return deferred(); };
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        QSignalSpy closed(&client, &ControlClient::closed);
        client.start();
        QVERIFY(opened.wait(2000));
        QString code;
        client.invoke(u"agent:prompt"_s, {QJsonObject{{"text", "hi"}}}, [&](const ControlResult& r) { code = r.code; });
        QTRY_COMPARE(daemon.requests(u"agent:prompt"_s).size(), 1);
        daemon.dropClients();
        QTRY_COMPARE(code, u"closed"_s);
        QCOMPARE(closed.size(), 1);
        QTRY_COMPARE_WITH_TIMEOUT(opened.size(), 2, 3000);
        QCOMPARE(client.state(), ControlClient::State::Open);
    }

    void retriesUntilTheDaemonAppears()
    {
        FakeDaemon daemon; // secret written, nobody listening yet
        ControlClient client(optionsFor(daemon));
        client.start();
        QTRY_COMPARE(client.state(), ControlClient::State::Waiting);
        QVERIFY(daemon.listen());
        QTRY_COMPARE_WITH_TIMEOUT(client.state(), ControlClient::State::Open, 3000);
    }

    void missingSecretIsRetried()
    {
        FakeDaemon daemon;
        QVERIFY(daemon.listen());
        QByteArray secret;
        {
            QFile file(daemon.secretPath());
            QVERIFY(file.open(QIODevice::ReadOnly));
            secret = file.readAll();
        }
        QVERIFY(QFile::remove(daemon.secretPath()));
        ControlClient client(optionsFor(daemon));
        client.start();
        QTRY_VERIFY(client.lastError().contains(u"not running"_s));
        QFile file(daemon.secretPath());
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(secret);
        file.close();
        QTRY_COMPARE_WITH_TIMEOUT(client.state(), ControlClient::State::Open, 3000);
    }

    void timesOutASilentDaemon()
    {
        FakeDaemon daemon;
        daemon.silent = true;
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        client.start();
        QTRY_VERIFY_WITH_TIMEOUT(client.lastError().contains(u"did not answer"_s), 3000);
    }

    void dropsAnOversizeFrameBeforeWelcome()
    {
        FakeDaemon daemon;
        daemon.rawChallenge = QByteArray::fromHex("0000138800") + QByteArray(5000, 'x');
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        client.start();
        QTRY_COMPARE(client.lastError(), u"Bad control frame"_s);
        QVERIFY(client.state() != ControlClient::State::Open);
    }

    void stopFailsPendingAndStaysIdle()
    {
        FakeDaemon daemon;
        daemon.handler = [](const QString&, const QJsonArray&, quint64) { return deferred(); };
        QVERIFY(daemon.listen());
        ControlClient client(optionsFor(daemon));
        QSignalSpy opened(&client, &ControlClient::opened);
        client.start();
        QVERIFY(opened.wait(2000));
        QString code;
        client.invoke(u"x:y"_s, {}, [&](const ControlResult& r) { code = r.code; });
        client.stop();
        QCOMPARE(code, u"closed"_s);
        QCOMPARE(client.state(), ControlClient::State::Idle);
        QTest::qWait(100);
        QCOMPARE(opened.size(), 1);
    }

    void backoffSteps()
    {
        QCOMPARE(backoffDelay({250, 500, 1000}, 0), 250);
        QCOMPARE(backoffDelay({250, 500, 1000}, 1), 500);
        QCOMPARE(backoffDelay({250, 500, 1000}, 7), 1000);
        QCOMPARE(backoffDelay({}, 3), 1000);
    }
};

QTEST_GUILESS_MAIN(TestControlClient)
#include "tst_controlclient.moc"
