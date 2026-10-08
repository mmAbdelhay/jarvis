#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryFile>
#include <QFile>
#include <QScopeGuard>
#include <QtTest>
#include <memory>

#include "FakeGreetd.h"
#include "FakePower.h"
#include "GreetdClient.h"
#include "LoginModel.h"

using namespace Qt::StringLiterals;

namespace {
struct Fixture {
    FakeGreetd greetd;
    FakePower power;
    std::unique_ptr<GreetdClient> client;
    std::unique_ptr<LoginModel> login;
    explicit Fixture(QList<UserEntry> users = {{u"mohamed"_s, u"Mohamed Abdelhay"_s, 1000}})
    {
        if (!greetd.listen())
            qFatal("fake greetd cannot listen");
        client = std::make_unique<GreetdClient>(greetd.socketPath());
        login = std::make_unique<LoginModel>(client.get(), &power, users);
        login->setSessionExec(u"labwc"_s);
    }
    QStringList types() const
    {
        QStringList out;
        for (const QJsonObject& r : greetd.received)
            out << r.value("type").toString();
        return out;
    }
};
} // namespace

class TestLoginModel : public QObject {
    Q_OBJECT
private slots:
    void defaultSessionFallback_data()
    {
        QTest::addColumn<QByteArray>("desktop");
        QTest::addColumn<bool>("explicitChoice");
        QTest::addColumn<QStringList>("command");
        QTest::newRow("missing-default") << QByteArray{} << false << QStringList{"labwc"};
        QTest::newRow("malformed-default") << QByteArray{"invalid"} << false << QStringList{"labwc"};
        QTest::newRow("invalid-exec-default") << QByteArray{"[Desktop Entry]\nType=Application\nName=Test\nExec=labwc %Z\n"} << false << QStringList{"labwc"};
        QTest::newRow("missing-explicit") << QByteArray{} << true << QStringList{};
        QTest::newRow("malformed-explicit") << QByteArray{"invalid"} << true << QStringList{};
        QTest::newRow("valid-default") << QByteArray{"[Desktop Entry]\nType=Application\nName=Test\nExec=jarvis-classic --chat\n"} << false << QStringList{"jarvis-classic", "--chat"};
        QTest::newRow("valid-explicit") << QByteArray{"[Desktop Entry]\nType=Application\nName=Test\nExec=jarvis-classic --chat\n"} << true << QStringList{"jarvis-classic", "--chat"};
    }

    void defaultSessionFallback()
    {
        QFETCH(QByteArray, desktop);
        QFETCH(bool, explicitChoice);
        QFETCH(QStringList, command);
        QTemporaryFile file;
        QVERIFY(file.open());
        file.write(desktop);
        file.close();
        const QString path = file.fileName();
        if (desktop.isEmpty()) QVERIFY(file.remove());
        GreetdClient client(u"/nonexistent/greetd.sock"_s);
        FakePower power;
        LoginModel login(&client, &power, {{u"mohamed"_s, u"Mohamed"_s, 1000}});
        login.setSessionFile(path, explicitChoice);
        login.submit(u"right horse"_s);
        if (command.isEmpty()) {
            QCOMPARE(login.errorText(), u"The selected session is unavailable."_s);
            QCOMPARE(login.state(), u"idle"_s);
        } else {
            // Reaching the offline login service proves session validation passed.
            QCOMPARE(login.errorText(), u"The login service isn't running."_s);
            QCOMPARE(login.failures(), 1);
        }
    }

    void defaultUserIsShown()
    {
        Fixture f;
        QCOMPARE(f.login->username(), u"mohamed"_s);
        QCOMPARE(f.login->displayName(), u"Mohamed Abdelhay"_s);
        QCOMPARE(f.login->initial(), u"M"_s);
        QCOMPARE(f.login->state(), u"idle"_s);
        QCOMPARE(f.login->promptText(), u"Password"_s);
        QVERIFY(f.login->promptSecret());
    }

    void rightPasswordStartsLabwc()
    {
        Fixture f;
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        QCOMPARE(f.login->state(), u"busy"_s);
        QTRY_COMPARE(started.size(), 1);
        QCOMPARE(f.types(), (QStringList{u"create_session"_s, u"post_auth_message_response"_s, u"start_session"_s}));
        QCOMPARE(f.greetd.received.at(0).value("username").toString(), u"mohamed"_s);
        QCOMPARE(f.greetd.received.at(1).value("response").toString(), u"right horse"_s);
        QCOMPARE(f.greetd.received.at(2).value("cmd").toArray(), QJsonArray{u"labwc"_s});
        QCOMPARE(f.login->state(), u"starting"_s);
    }

    void unchangedLanguagePassesEnvironmentLocaleWhenSystemFileIsAbsent()
    {
        if (QFile::exists(u"/etc/default/locale"_s))
            QSKIP("System locale file takes precedence; covered by fixture locale tests.");
        const QByteArray previous = qgetenv("LANG");
        const bool wasSet = qEnvironmentVariableIsSet("LANG");
        const auto restore = qScopeGuard([&] {
            if (wasSet) qputenv("LANG", previous);
            else qunsetenv("LANG");
        });
        qputenv("LANG", "en_GB.UTF-8");
        Fixture f;
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(started.size(), 1);
        QCOMPARE(f.greetd.received.last().value("env").toArray(), QJsonArray{u"LANG=en_GB.UTF-8"_s});
    }

    void wrongPasswordShowsAnErrorThenRetryWorks()
    {
        Fixture f;
        QSignalSpy failures(f.login.get(), &LoginModel::failuresChanged);
        f.login->submit(u"wrong"_s);
        QTRY_COMPARE(f.login->state(), u"idle"_s);
        QCOMPARE(f.login->errorText(), u"That password didn't work. Try again."_s);
        QCOMPARE(f.types().last(), u"cancel_session"_s);
        QCOMPARE(failures.size(), 1);
        QCOMPARE(f.login->failures(), 1);
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        QCOMPARE(f.login->errorText(), QString());
        QTRY_COMPARE(started.size(), 1);
    }

    void extraPromptIsAskedOfThePerson()
    {
        Fixture f;
        f.greetd.extraPrompt = u"Verification code:"_s;
        f.greetd.extraAnswer = u"123456"_s;
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(f.login->state(), u"prompt"_s);
        QCOMPARE(f.login->promptText(), u"Verification code:"_s);
        QVERIFY(!f.login->promptSecret());
        f.login->submit(u"123456"_s);
        QTRY_COMPARE(started.size(), 1);
    }

    void infoMessageIsShownAndAcknowledged()
    {
        Fixture f;
        f.greetd.infoMessage = u"Your password expires in 3 days"_s;
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(started.size(), 1);
        QCOMPARE(f.login->infoText(), u"Your password expires in 3 days"_s);
        QVERIFY(!f.greetd.received.at(1).contains("response")); // the info ack carries no answer
        QCOMPARE(f.greetd.received.at(2).value("response").toString(), u"right horse"_s);
    }

    void startErrorIsShown()
    {
        Fixture f;
        f.greetd.startError = u"labwc: not found"_s;
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(f.login->state(), u"idle"_s);
        QCOMPARE(f.login->errorText(), u"Couldn't start the session: labwc: not found"_s);
    }

    void lostConnectionThenRetrySucceeds()
    {
        Fixture f;
        f.greetd.dropOnCreate = true;
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(f.login->state(), u"idle"_s);
        QCOMPARE(f.login->errorText(), u"Lost the connection to the login service."_s);
        QCOMPARE(f.login->failures(), 1);
        f.greetd.dropOnCreate = false;
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(started.size(), 1);
    }

    void busySubmitIsIgnored()
    {
        Fixture f;
        f.login->submit(u"right horse"_s);
        f.login->submit(u"right horse"_s);
        QTRY_COMPARE(f.login->state(), u"starting"_s);
        QCOMPARE(f.types().count(u"create_session"_s), 1);
    }

    void otherUserNeedsAName()
    {
        Fixture f;
        f.login->useOtherUser();
        QVERIFY(f.login->otherUser());
        QCOMPARE(f.login->displayName(), u"Other user"_s);
        QCOMPARE(f.login->initial(), u"?"_s);
        f.login->submit(u"x"_s);
        QCOMPARE(f.login->errorText(), u"Type your username."_s);
        QVERIFY(f.greetd.received.isEmpty());
        f.login->setUsername(u"sara"_s);
        QCOMPARE(f.login->initial(), u"S"_s);
        QVERIFY(f.login->canSwitchUser());
        f.login->useDefaultUser();
        QCOMPARE(f.login->username(), u"mohamed"_s);
    }

    void noUsersMeansOtherUserMode()
    {
        Fixture f({});
        QVERIFY(f.login->otherUser());
        QVERIFY(!f.login->canSwitchUser());
    }

    void powerGoesThroughLogind()
    {
        Fixture f;
        QVERIFY(f.login->powerAvailable());
        f.login->powerOff();
        f.login->reboot();
        QCOMPARE(f.power.calls, (QStringList{u"PowerOff"_s, u"Reboot"_s}));
        emit f.power.failed(u"Not allowed"_s);
        QCOMPARE(f.login->errorText(), u"Couldn't do that: Not allowed"_s);
    }
};

QTEST_GUILESS_MAIN(TestLoginModel)
#include "tst_loginmodel.moc"
