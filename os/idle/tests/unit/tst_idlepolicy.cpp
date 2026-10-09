#include <QSignalSpy>
#include <QtTest>

#include "core/IdlePolicy.h"

class TestIdlePolicy : public QObject {
    Q_OBJECT
    qint64 m_now = 1'000'000;

private slots:
    void idleLaunchesOnce()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy launch(&policy, &IdlePolicy::launchLock);
        policy.onIdle();
        policy.onIdle();
        policy.onLockRequested();
        policy.onLidClosed();
        QCOMPARE(launch.size(), 1);
        QVERIFY(policy.isRunning());
    }

    void everyTriggerLocks()
    {
        for (int trigger = 0; trigger < 4; ++trigger) {
            IdlePolicy policy([this] { return m_now; });
            QSignalSpy launch(&policy, &IdlePolicy::launchLock);
            switch (trigger) {
            case 0: policy.onIdle(); break;
            case 1: policy.onLidClosed(); break;
            case 2: policy.onLockRequested(); break;
            default: policy.onSleepComing(); break;
            }
            QCOMPARE(launch.size(), 1);
        }
    }

    void sleepWaitsForTheLockToShow()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy release(&policy, &IdlePolicy::releaseSleepDelay);
        policy.onSleepComing();
        QCOMPARE(release.size(), 0);
        policy.onLockConfirmed();
        QCOMPARE(release.size(), 1);
    }

    void finishedSleepDoesNotReleaseALaterDelay()
    {
        IdlePolicy policy;
        QSignalSpy release(&policy, &IdlePolicy::releaseSleepDelay);
        policy.onSleepComing();
        policy.onSleepFinished(); // fallback fired or system resumed
        policy.onLockConfirmed();
        QCOMPARE(release.count(), 0);
        policy.onLockExited(0, false);
        QCOMPARE(release.count(), 0);
    }

    void sleepWhileLockedReleasesAtOnce()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy launch(&policy, &IdlePolicy::launchLock);
        QSignalSpy release(&policy, &IdlePolicy::releaseSleepDelay);
        policy.onIdle();
        policy.onLockConfirmed();
        policy.onSleepComing();
        QCOMPARE(release.size(), 1);
        QCOMPARE(launch.size(), 1);
    }

    void relaunchesACrashedLock()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy launch(&policy, &IdlePolicy::launchLock);
        policy.onIdle();
        policy.onLockExited(0, true); // killed by a signal
        QCOMPARE(launch.size(), 2);
        policy.onLockExited(1, false); // lost its lock
        QCOMPARE(launch.size(), 3);
        QVERIFY(policy.isRunning());
    }

    void doesNotRelaunchARefusedLock()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy launch(&policy, &IdlePolicy::launchLock);
        policy.onIdle();
        policy.onLockExited(2, false);
        QCOMPARE(launch.size(), 1);
        QVERIFY(!policy.isRunning());
        policy.onIdle();
        policy.onLockExited(3, false);
        QCOMPARE(launch.size(), 2);
    }

    void unlockedLockIsDone()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy launch(&policy, &IdlePolicy::launchLock);
        policy.onIdle();
        policy.onLockExited(0, false);
        QCOMPARE(launch.size(), 1);
        QVERIFY(!policy.isRunning());
        policy.onIdle();
        QCOMPARE(launch.size(), 2);
    }

    void givesUpAfterFiveCrashesInAMinute()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy launch(&policy, &IdlePolicy::launchLock);
        QSignalSpy gaveUp(&policy, &IdlePolicy::gaveUp);
        policy.onIdle();
        for (int i = 0; i < IdlePolicy::kMaxRestarts; ++i) {
            m_now += 1000;
            policy.onLockExited(1, false);
        }
        QCOMPARE(launch.size(), 1 + IdlePolicy::kMaxRestarts);
        m_now += 1000;
        policy.onLockExited(1, false);
        QCOMPARE(launch.size(), 1 + IdlePolicy::kMaxRestarts);
        QCOMPARE(gaveUp.size(), 1);
        QVERIFY(!policy.isRunning());
        m_now += IdlePolicy::kRestartWindowMs + 1;
        policy.onIdle(); // a later trigger tries again
        QCOMPARE(launch.size(), 2 + IdlePolicy::kMaxRestarts);
    }

    void missingLockerGivesUpAndReleasesSleep()
    {
        IdlePolicy policy([this] { return m_now; });
        QSignalSpy gaveUp(&policy, &IdlePolicy::gaveUp);
        QSignalSpy release(&policy, &IdlePolicy::releaseSleepDelay);
        policy.onSleepComing();
        policy.onLockExited(127, false);
        QCOMPARE(gaveUp.size(), 1);
        QCOMPARE(release.size(), 1);
    }
};

QTEST_GUILESS_MAIN(TestIdlePolicy)
#include "tst_idlepolicy.moc"
