#include <QJsonDocument>
#include <QtTest>

#include "AccountChoice.h"

using namespace Qt::StringLiterals;

class TestAccountChoice : public QObject {
    Q_OBJECT

    static void fill(AccountChoice& a)
    {
        a.setFullName(u"Mohamed Abdelhay"_s);
        a.setPassword(u"abcdEF12"_s);
        a.setConfirm(u"abcdEF12"_s);
    }

private slots:
    void namesAreDerivedUntilEdited()
    {
        AccountChoice a;
        a.setFullName(u"Mohamed Abdelhay"_s);
        QCOMPARE(a.username(), u"mohamed"_s);
        QCOMPARE(a.hostname(), u"mohamed-computer"_s);
        a.setUsername(u"mo"_s);
        a.setFullName(u"Someone Else"_s);
        QCOMPARE(a.username(), u"mo"_s);
        QCOMPARE(a.hostname(), u"mo-computer"_s);
        a.setHostname(u"study"_s);
        a.setUsername(u"mm"_s);
        QCOMPARE(a.hostname(), u"study"_s);
        a.setUsername(QString());                  // cleared: derive again
        QCOMPARE(a.username(), QString());
        a.setFullName(u"Sara"_s);
        QCOMPARE(a.username(), u"sara"_s);
    }

    void validationOrder()
    {
        AccountChoice a;
        QCOMPARE(a.blockText(), u"Enter your name."_s);
        a.setFullName(u"محمد"_s);                  // nothing to derive from
        QCOMPARE(a.blockText(), u"Choose a username."_s);
        a.setUsername(u"root"_s);
        QCOMPARE(a.usernameProblem(), u"That name is used by the system. Pick another."_s);
        a.setUsername(u"mohamed"_s);
        QCOMPARE(a.blockText(), u"Choose a password."_s);
        a.setPassword(u"abc"_s);
        QCOMPARE(a.blockText(), u"Use at least 8 characters for the password."_s);
        a.setPassword(u"abcdEF12"_s);
        QCOMPARE(a.blockText(), u"The passwords don't match."_s);
        a.setConfirm(u"abcdEF12"_s);
        QCOMPARE(a.passwordStatus(), u"Strong password · passwords match"_s);
        QVERIFY(a.valid());
        QCOMPARE(a.blockText(), QString());
    }

    void separateDiskPassphraseOnlyWhenAsked()
    {
        AccountChoice a;
        fill(a);
        a.setEncrypt(true);
        QVERIFY(a.valid());                         // same as the password by default
        a.setDiskSameAsPassword(false);
        QCOMPARE(a.blockText(), u"Use at least 8 characters for the disk passphrase."_s);
        a.setDiskPassphrase(u"disk pass 1"_s);
        a.setDiskConfirm(u"disk pass 2"_s);
        QCOMPARE(a.blockText(), u"The disk passphrases don't match."_s);
        a.setDiskConfirm(u"disk pass 1"_s);
        QVERIFY(a.valid());
        a.setEncrypt(false);
        a.setDiskConfirm(u"x"_s);
        QVERIFY(a.valid());                         // no encryption: the passphrase does not matter
    }

    void jsonCarriesNoSecrets()
    {
        AccountChoice a;
        fill(a);
        a.setAutologin(true);
        QCOMPARE(a.toJson(), (QJsonObject{{"fullName", "Mohamed Abdelhay"}, {"username", "mohamed"},
                                         {"hostname", "mohamed-computer"}, {"autologin", true}}));
        QVERIFY(!QJsonDocument(a.toJson()).toJson().contains("abcdEF12"));
    }

    void secretsJsonFollowsEncryption()
    {
        AccountChoice a;
        fill(a);
        a.setEncrypt(false);
        QCOMPARE(QJsonDocument::fromJson(a.secretsJson()).object(),
                 (QJsonObject{{"userPassword", "abcdEF12"}, {"luksPassphrase", QJsonValue::Null}}));
        a.setEncrypt(true);
        QCOMPARE(QJsonDocument::fromJson(a.secretsJson()).object().value("luksPassphrase").toString(), u"abcdEF12"_s);
        a.setDiskSameAsPassword(false);
        a.setDiskPassphrase(u"disk pass 1"_s);
        a.setDiskConfirm(u"disk pass 1"_s);
        QCOMPARE(QJsonDocument::fromJson(a.secretsJson()).object().value("luksPassphrase").toString(), u"disk pass 1"_s);
    }

    void wipeClearsEverySecret()
    {
        AccountChoice a;
        fill(a);
        a.setDiskSameAsPassword(false);
        a.setDiskPassphrase(u"disk pass 1"_s);
        a.setDiskConfirm(u"disk pass 1"_s);
        a.wipe();
        QVERIFY(a.password().isEmpty());
        QVERIFY(a.confirm().isEmpty());
        QVERIFY(a.diskPassphrase().isEmpty());
        QVERIFY(a.diskConfirm().isEmpty());
        QCOMPARE(a.username(), u"mohamed"_s);       // non-secret fields stay
    }
};

QTEST_GUILESS_MAIN(TestAccountChoice)
#include "tst_accountchoice.moc"
