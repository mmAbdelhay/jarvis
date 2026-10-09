#include <QSignalSpy>
#include <QtTest>

#include "FakeLogind.h"
#include "linux/LogindWatcher.h"

using namespace Qt::StringLiterals;

class TestLogindWatcher : public QObject {
    Q_OBJECT
private slots:
    void noLogindMeansNoWatcher()
    {
        LogindWatcher watcher(QDBusConnection::sessionBus());
        QVERIFY(!watcher.start()); // nobody owns org.freedesktop.login1 yet
    }

    void lockSleepAndLid()
    {
        FakeLogind logind;
        QVERIFY(logind.start());
        LogindWatcher watcher(QDBusConnection::sessionBus());
        watcher.setLidPollIntervalForTest(20);
        QSignalSpy lock(&watcher, &LogindWatcher::lockRequested);
        QSignalSpy sleep(&watcher, &LogindWatcher::sleepComing);
        QSignalSpy resumed(&watcher, &LogindWatcher::resumed);
        QSignalSpy lid(&watcher, &LogindWatcher::lidClosed);
        QVERIFY(watcher.start());

        QCOMPARE(logind.inhibitCalls.load(), 1);
        QTRY_VERIFY(logind.delayHeld());

        logind.emitLock(); // loginctl lock-session (Super+L)
        QTRY_COMPARE(lock.size(), 1);

        logind.emitPrepareForSleep(true);
        QTRY_COMPARE(sleep.size(), 1);
        watcher.releaseSleepDelay();
        QTRY_VERIFY(!logind.delayHeld());
        logind.emitPrepareForSleep(false);
        QTRY_COMPARE(resumed.size(), 1);
        QCOMPARE(logind.inhibitCalls.load(), 2);
        QTRY_VERIFY(logind.delayHeld());

        logind.lidClosed = true;
        QTRY_COMPARE(lid.size(), 1);
        QTest::qWait(150);
        QCOMPARE(lid.size(), 1); // an edge, not a level
        logind.lidClosed = false;
        QTest::qWait(100);
        logind.lidClosed = true;
        QTRY_COMPARE(lid.size(), 2);
    }
};

QTEST_GUILESS_MAIN(TestLogindWatcher)
#include "tst_logindwatcher.moc"
