#include <QtTest>
#include <memory>
#include <optional>

#include "FakeAuthenticator.h"
#include "FakeDaemon.h"
#include "app/LockBackend.h"
#include "app/LockSession.h"
#include "control/ControlClient.h"
#include "model/LockModel.h"
#include "report/LockReporter.h"

using namespace Qt::StringLiterals;

namespace {
// Emits the base class's signals, so no Q_OBJECT (no moc) is needed.
class FakeBackend : public LockBackend {
public:
    using LockBackend::LockBackend;
    bool canLock = true;
    int lockCalls = 0;
    int unlockCalls = 0;
    bool lock() override { ++lockCalls; return canLock; }
    void unlock() override { ++unlockCalls; }
    void grant() { emit locked(); }
    void end() { emit finished(); }
};

struct Rig {
    FakeDaemon daemon;
    std::unique_ptr<ControlClient> client;
    std::unique_ptr<LockReporter> reporter;
    FakeAuthenticator auth;
    LockModel model{&auth, CurrentUser{u"m"_s, u"M"_s}};
    FakeBackend backend;
    QStringList said;
    std::optional<int> exitCode;
    std::unique_ptr<LockSession> session;

    Rig()
    {
        daemon.listen();
        ControlOptions options;
        options.socketPath = daemon.socketPath();
        options.secretPath = daemon.secretPath();
        options.backoffMs = {20};
        client = std::make_unique<ControlClient>(options);
        client->start();
        (void)QTest::qWaitFor([this] { return client->state() == ControlClient::State::Open; }, 3000);
        reporter = std::make_unique<LockReporter>(client.get());
        session = std::make_unique<LockSession>(&backend, reporter.get(), &model,
                                                [this](const QString& line) { said.append(line); });
        QObject::connect(session.get(), &LockSession::exitRequested, [this](int code) { exitCode = code; });
    }
    QList<bool> sent() const
    {
        QList<bool> out;
        for (const QJsonObject& r : daemon.requests(u"sys:setLocked"_s))
            out.append(r.value("a").toArray().at(0).toObject().value("locked").toBool());
        return out;
    }
    void typeRightPassword()
    {
        model.submit(u"pw"_s);
        auth.resolve(true);
    }
};
} // namespace

class TestLockSession : public QObject {
    Q_OBJECT
private slots:
    void reportsLockedBeforeAskingTheCompositor()
    {
        Rig rig;
        QVERIFY(rig.session->start());
        QCOMPARE(rig.backend.lockCalls, 1);
        QTRY_COMPARE(rig.sent(), (QList<bool>{true}));
        QVERIFY(rig.said.isEmpty());
    }

    void printsLockedWhenTheCompositorConfirms()
    {
        Rig rig;
        rig.session->start();
        rig.backend.grant();
        QCOMPARE(rig.said, (QStringList{u"locked"_s}));
        QVERIFY(rig.session->isLocked());
    }

    void unlockReportsThenUnlocksThenExitsZero()
    {
        Rig rig;
        rig.session->start();
        rig.backend.grant();
        rig.typeRightPassword();
        QTRY_COMPARE(rig.exitCode, std::optional<int>(LockSession::Unlocked));
        QCOMPARE(rig.backend.unlockCalls, 1);
        QCOMPARE(rig.sent(), (QList<bool>{true, false}));
        QCOMPARE(rig.said, (QStringList{u"locked"_s, u"unlocked"_s}));
    }

    void unlockBeforeLockedWaitsForLocked()
    {
        Rig rig;
        rig.session->start();
        rig.typeRightPassword(); // typed before the compositor confirmed
        QTest::qWait(100);
        QCOMPARE(rig.backend.unlockCalls, 0);
        QVERIFY(!rig.exitCode);
        rig.backend.grant();
        QTRY_COMPARE(rig.exitCode, std::optional<int>(LockSession::Unlocked));
        QCOMPARE(rig.backend.unlockCalls, 1);
    }

    void wrongPasswordKeepsTheLock()
    {
        Rig rig;
        rig.session->start();
        rig.backend.grant();
        rig.model.submit(u"nope"_s);
        rig.auth.resolve(false);
        QTest::qWait(100);
        QCOMPARE(rig.backend.unlockCalls, 0);
        QVERIFY(!rig.exitCode);
        QCOMPARE(rig.sent(), (QList<bool>{true}));
    }

    void refusedLockExitsTwoAndReportsUnlocked()
    {
        Rig rig;
        rig.session->start();
        rig.backend.end(); // finished before locked: another locker, or policy
        QTRY_COMPARE(rig.exitCode, std::optional<int>(LockSession::Refused));
        QCOMPARE(rig.sent(), (QList<bool>{true, false}));
        QCOMPARE(rig.backend.unlockCalls, 0);
        QCOMPARE(rig.said, (QStringList{u"refused"_s}));
    }

    void backendThatCannotLockExitsTwo()
    {
        Rig rig;
        rig.backend.canLock = false;
        QVERIFY(!rig.session->start());
        QTRY_COMPARE(rig.exitCode, std::optional<int>(LockSession::Refused));
    }

    void lostLockExitsOneAndStaysLockedForJarvisd()
    {
        Rig rig;
        rig.session->start();
        rig.backend.grant();
        rig.backend.end();
        QTRY_COMPARE(rig.exitCode, std::optional<int>(LockSession::LostLock));
        QTest::qWait(100);
        QCOMPARE(rig.sent(), (QList<bool>{true})); // jarvis-idle relaunches; approvals stay refused
        QCOMPARE(rig.backend.unlockCalls, 0);
    }
};

QTEST_GUILESS_MAIN(TestLockSession)
#include "tst_locksession.moc"
