#include <QtTest>
#include <memory>

#include "FakeDaemon.h"
#include "control/ControlClient.h"
#include "report/LockReporter.h"

using namespace Qt::StringLiterals;

namespace {
struct Rig {
    FakeDaemon daemon;
    std::unique_ptr<ControlClient> client;
    std::unique_ptr<LockReporter> reporter;
    explicit Rig(bool listen = true)
    {
        if (listen)
            daemon.listen();
        ControlOptions options;
        options.socketPath = daemon.socketPath();
        options.secretPath = daemon.secretPath();
        options.backoffMs = {20};
        client = std::make_unique<ControlClient>(options);
        reporter = std::make_unique<LockReporter>(client.get());
    }
    bool open()
    {
        client->start();
        return QTest::qWaitFor([this] { return client->state() == ControlClient::State::Open; }, 3000);
    }
    QList<bool> sent() const
    {
        QList<bool> out;
        for (const QJsonObject& r : daemon.requests(u"sys:setLocked"_s))
            out.append(r.value("a").toArray().at(0).toObject().value("locked").toBool());
        return out;
    }
    void defer()
    {
        daemon.handler = [](const QString&, const QJsonArray&, quint64) {
            FakeDaemon::Reply reply;
            reply.defer = true;
            return reply;
        };
    }
};
} // namespace

class TestLockReporter : public QObject {
    Q_OBJECT
private slots:
    void sendsNothingBeforeAnyState()
    {
        Rig rig;
        QVERIFY(rig.open());
        QTest::qWait(100);
        QVERIFY(rig.sent().isEmpty());
    }

    void sendsLockedOnceConnected()
    {
        Rig rig;
        rig.reporter->setLocked(true); // jarvisd not reachable yet
        QVERIFY(rig.open());
        QTRY_COMPARE(rig.sent(), (QList<bool>{true}));
    }

    void resendsLockedAfterEveryReconnect()
    {
        Rig rig;
        QVERIFY(rig.open());
        rig.reporter->setLocked(true);
        QTRY_COMPARE(rig.sent(), (QList<bool>{true}));
        rig.daemon.dropClients(); // jarvisd restarted mid-lock
        QTRY_COMPARE(rig.sent(), (QList<bool>{true, true}));
        rig.daemon.dropClients();
        QTRY_COMPARE(rig.sent(), (QList<bool>{true, true, true}));
    }

    void unlockWaitsForTheReply()
    {
        Rig rig;
        rig.defer();
        QVERIFY(rig.open());
        int called = 0;
        rig.reporter->reportUnlocked([&] { ++called; }, 5000);
        QTRY_COMPARE(rig.sent(), (QList<bool>{false}));
        QTest::qWait(150);
        QCOMPARE(called, 0);
        rig.daemon.respond(quint64(rig.daemon.requests(u"sys:setLocked"_s).constLast().value("id").toDouble()), QJsonValue::Null);
        QTRY_COMPARE(called, 1);
        QVERIFY(!rig.reporter->locked());
    }

    void unlockDoesNotWaitForADeadDaemon()
    {
        Rig rig(false); // nothing listening
        rig.client->start();
        int called = 0;
        rig.reporter->reportUnlocked([&] { ++called; });
        QTRY_COMPARE_WITH_TIMEOUT(called, 1, 500);
    }

    void unlockGivesUpOnASilentDaemonExactlyOnce()
    {
        Rig rig;
        rig.defer();
        QVERIFY(rig.open());
        int called = 0;
        rig.reporter->reportUnlocked([&] { ++called; }, 100);
        QTRY_COMPARE(called, 1);
        rig.daemon.respond(quint64(rig.daemon.requests(u"sys:setLocked"_s).constLast().value("id").toDouble()), QJsonValue::Null);
        QTest::qWait(100);
        QCOMPARE(called, 1);
    }
};

QTEST_GUILESS_MAIN(TestLockReporter)
#include "tst_lockreporter.moc"
