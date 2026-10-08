#include <QFile>
#include <QSignalSpy>
#include <QtTest>

#include "auth/PamAuthenticator.h"
#include "model/CurrentUser.h"

using namespace Qt::StringLiterals;

class TestPam : public QObject {
    Q_OBJECT
    static bool check(const QString& user, const QByteArray& password)
    {
        PamAuthenticator pam;
        QSignalSpy finished(&pam, &Authenticator::finished);
        pam.start(user, password);
        if (!finished.wait(15000))
            return false;
        return finished[0][0].toBool();
    }

private slots:
    void initTestCase()
    {
        QVERIFY2(qEnvironmentVariableIsSet("PAM_WRAPPER"), "run through ctest (LD_PRELOAD=libpam_wrapper)");
        QFile passdb(QStringLiteral(JARVIS_PAM_PASSDB));
        QVERIFY(passdb.open(QIODevice::WriteOnly | QIODevice::Truncate));
        passdb.write((currentUser().login + u":right-pass:jarvis-lock\n"_s).toUtf8());
    }
    void rightPasswordPasses() { QVERIFY(check(currentUser().login, "right-pass")); }
    void wrongPasswordFails() { QVERIFY(!check(currentUser().login, "wrong-pass")); }
    void emptyPasswordFails() { QVERIFY(!check(currentUser().login, QByteArray())); }
    void unknownUserFails() { QVERIFY(!check(u"no-such-user-jarvis"_s, "right-pass")); }
    void destroyingWhileCheckingIsSafe()
    {
        {
            PamAuthenticator pam;
            pam.start(currentUser().login, "right-pass");
        } // the destructor joins the worker
        QVERIFY(true);
    }
};

QTEST_GUILESS_MAIN(TestPam)
#include "tst_pam.moc"
