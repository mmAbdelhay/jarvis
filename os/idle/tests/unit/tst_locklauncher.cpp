#include <QSignalSpy>
#include <QtTest>

#include "core/LockLauncher.h"

using namespace Qt::StringLiterals;

namespace {
QString fakeLock() { return QStringLiteral(JARVIS_IDLE_TEST_DATA "/fake-lock.sh"); }
} // namespace

class TestLockLauncher : public QObject {
    Q_OBJECT
private slots:
    void confirmsThenExits()
    {
        LockLauncher launcher(u"sh"_s, {fakeLock(), u"0"_s, u"0.2"_s});
        QSignalSpy confirmed(&launcher, &LockLauncher::confirmed);
        QSignalSpy exited(&launcher, &LockLauncher::exited);
        launcher.launch();
        QVERIFY(launcher.running());
        QTRY_COMPARE(confirmed.size(), 1);
        QTRY_COMPARE(exited.size(), 1);
        QCOMPARE(exited[0][0].toInt(), 0);
        QCOMPARE(exited[0][1].toBool(), false);
    }

    void exitCodePassesThrough()
    {
        LockLauncher launcher(u"sh"_s, {fakeLock(), u"2"_s, u"0"_s});
        QSignalSpy exited(&launcher, &LockLauncher::exited);
        launcher.launch();
        QTRY_COMPARE(exited.size(), 1);
        QCOMPARE(exited[0][0].toInt(), 2);
    }

    void crashIsReported()
    {
        LockLauncher launcher(u"sh"_s, {u"-c"_s, u"kill -KILL $$"_s});
        QSignalSpy exited(&launcher, &LockLauncher::exited);
        launcher.launch();
        QTRY_COMPARE(exited.size(), 1);
        QVERIFY(exited[0][1].toBool());
    }

    void missingProgramIs127()
    {
        LockLauncher launcher(u"/nonexistent/jarvis-lock"_s);
        QSignalSpy exited(&launcher, &LockLauncher::exited);
        launcher.launch();
        QTRY_COMPARE(exited.size(), 1);
        QCOMPARE(exited[0][0].toInt(), 127);
        QVERIFY(!launcher.running());
    }

    void secondLaunchWhileRunningIsIgnored()
    {
        LockLauncher launcher(u"sh"_s, {fakeLock(), u"0"_s, u"0.5"_s});
        QSignalSpy exited(&launcher, &LockLauncher::exited);
        launcher.launch();
        launcher.launch();
        QTRY_COMPARE(exited.size(), 1);
        QTest::qWait(200);
        QCOMPARE(exited.size(), 1);
    }
};

QTEST_GUILESS_MAIN(TestLockLauncher)
#include "tst_locklauncher.moc"
