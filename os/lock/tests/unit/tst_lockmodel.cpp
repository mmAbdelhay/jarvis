#include <QSignalSpy>
#include <QtTest>

#include "FakeAuthenticator.h"
#include "model/CurrentUser.h"
#include "model/LockModel.h"

using namespace Qt::StringLiterals;

namespace {
CurrentUser muhammad() { return {u"muhammad"_s, u"Muhammad AbdElHay"_s}; }
} // namespace

class TestLockModel : public QObject {
    Q_OBJECT
private slots:
    void showsTheUser()
    {
        FakeAuthenticator auth;
        LockModel model(&auth, muhammad());
        QCOMPARE(model.displayName(), u"Muhammad AbdElHay"_s);
        QCOMPARE(model.initial(), u"M"_s);
        QCOMPARE(model.state(), u"ready"_s);
    }

    void rightPasswordUnlocks()
    {
        FakeAuthenticator auth;
        LockModel model(&auth, muhammad());
        QSignalSpy unlock(&model, &LockModel::unlockRequested);
        model.submit(u"right"_s);
        QCOMPARE(auth.calls, 1);
        QCOMPARE(auth.lastUser, u"muhammad"_s);
        QCOMPARE(auth.lastSecret, u"right"_s);
        QCOMPARE(model.state(), u"checking"_s);
        auth.resolve(true);
        QCOMPARE(unlock.size(), 1);
        QCOMPARE(model.state(), u"unlocking"_s);
        model.submit(u"again"_s);
        QCOMPARE(auth.calls, 1);
    }

    void wrongPasswordShowsWhy()
    {
        FakeAuthenticator auth;
        LockModel model(&auth, muhammad());
        model.submit(u"wrong"_s);
        auth.resolve(false);
        QCOMPARE(model.state(), u"ready"_s);
        QCOMPARE(model.failures(), 1);
        QCOMPARE(model.errorText(), u"That password didn't work. Try again."_s);
        model.submit(u"wrong"_s);
        auth.resolve(false, u"The account is locked due to 3 failed logins."_s);
        QCOMPARE(model.errorText(), u"That password didn't work: The account is locked due to 3 failed logins."_s);
    }

    void emptyAndBusySubmitsAreIgnored()
    {
        FakeAuthenticator auth;
        LockModel model(&auth, muhammad());
        model.submit(QString());
        QCOMPARE(auth.calls, 0);
        model.submit(u"a"_s);
        model.submit(u"b"_s);
        QCOMPARE(auth.calls, 1);
        QCOMPARE(auth.lastSecret, u"a"_s);
    }

    void cooldownAfterThreeFailures()
    {
        FakeAuthenticator auth;
        LockModel model(&auth, muhammad());
        for (int i = 0; i < 3; ++i) {
            model.submit(u"wrong"_s);
            auth.resolve(false);
        }
        QCOMPARE(model.state(), u"cooldown"_s);
        QCOMPARE(model.cooldownSeconds(), 5);
        model.submit(u"right"_s);
        QCOMPARE(auth.calls, 3);
        for (int i = 0; i < 5; ++i)
            model.tick();
        QCOMPARE(model.state(), u"ready"_s);
        model.submit(u"wrong"_s);
        auth.resolve(false);
        QCOMPARE(model.cooldownSeconds(), 10);
    }

    void cooldownSchedule()
    {
        const QList<int> expected{0, 0, 0, 5, 10, 20, 30, 30};
        for (int failures = 0; failures < expected.size(); ++failures)
            QCOMPARE(LockModel::cooldownFor(failures), expected[failures]);
        QCOMPARE(LockModel::cooldownFor(1000), 30);
    }

    void strayResultsAreIgnored()
    {
        FakeAuthenticator auth;
        LockModel model(&auth, muhammad());
        QSignalSpy unlock(&model, &LockModel::unlockRequested);
        auth.resolve(true); // nothing was asked
        QCOMPARE(unlock.size(), 0);
        QCOMPARE(model.state(), u"ready"_s);
    }

    void currentUserIsKnown()
    {
        const CurrentUser user = currentUser();
        QVERIFY(!user.login.isEmpty());
        QVERIFY(!user.displayName.isEmpty());
        QCOMPARE(user.initial().size(), 1);
    }
};

QTEST_GUILESS_MAIN(TestLockModel)
#include "tst_lockmodel.moc"
