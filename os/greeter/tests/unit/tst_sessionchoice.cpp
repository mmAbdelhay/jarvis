#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>
#include <memory>

#include "FakeGreetd.h"
#include "FakePower.h"
#include "GreetdClient.h"
#include "LoginModel.h"
#include "SessionChoice.h"
#include "Language.h"
#include <QScopeGuard>

using namespace Qt::StringLiterals;

namespace {
const QString kSessions = QStringLiteral(JARVIS_GREETER_TEST_DATA "/sessions");

struct Fixture {
    FakeGreetd greetd;
    FakePower power;
    std::unique_ptr<GreetdClient> client;
    std::unique_ptr<LoginModel> login;
    Fixture()
    {
        if (!greetd.listen())
            qFatal("fake greetd cannot listen");
        client = std::make_unique<GreetdClient>(greetd.socketPath());
        login = std::make_unique<LoginModel>(client.get(), &power, QList<UserEntry>{{u"mohamed"_s, u"Mohamed Abdelhay"_s, 1000}});
    }
    QJsonArray startedCommand()
    {
        QSignalSpy started(login.get(), &LoginModel::sessionStarted);
        login->submit(u"right horse"_s);
        if (!started.wait(3000))
            return {};
        return greetd.received.last().value("cmd").toArray();
    }
};
} // namespace

class TestSessionChoice : public QObject {
    Q_OBJECT
private slots:
    void readsOnlyUsableSessionsInOrder()
    {
        const QList<SessionEntry> sessions = readSessions(kSessions);
        QStringList ids;
        for (const SessionEntry& s : sessions)
            ids << s.id;
        QCOMPARE(ids, (QStringList{u"rafiq"_s, u"rafiq-classic"_s})); // gnome: TryExec missing; broken; hidden
        QCOMPARE(sessions.at(1).command, (QStringList{u"labwc"_s, u"-C"_s, u"/etc/xdg/labwc-classic"_s}));
        QCOMPARE(sessions.at(1).name(u"ar"_s), u"رفيق (الكلاسيكي)"_s);
        QCOMPARE(sessions.at(1).name(u"en"_s), u"Rafiq (classic)"_s);
    }

    void defaultSessionIsTheFirst()
    {
        Fixture f;
        f.login->setSessions(readSessions(kSessions));
        QCOMPARE(f.login->sessionId(), u"rafiq"_s);
        QCOMPARE(f.startedCommand(), QJsonArray{u"labwc"_s});
    }

    void classicSessionStartsItsCommand()
    {
        Fixture f;
        f.login->setSessions(readSessions(kSessions));
        QSignalSpy changed(f.login.get(), &LoginModel::sessionsChanged);
        f.login->setSessionId(u"rafiq-classic"_s);
        QCOMPARE(changed.size(), 1);
        QCOMPARE(f.startedCommand(), (QJsonArray{u"labwc"_s, u"-C"_s, u"/etc/xdg/labwc-classic"_s}));
    }

    void unknownSessionIdIsIgnored()
    {
        Fixture f;
        f.login->setSessions(readSessions(kSessions));
        f.login->setSessionId(u"broken"_s);
        f.login->setSessionId(u"../../bin/sh"_s);
        QCOMPARE(f.login->sessionId(), u"rafiq"_s);
    }

    void languageTogglePassesLangWithChosenCommand()
    {
        const QByteArray previous = qgetenv("JARVIS_I18N_DIR");
        const bool wasSet = qEnvironmentVariableIsSet("JARVIS_I18N_DIR");
        const auto restore = qScopeGuard([&] {
            if (wasSet) qputenv("JARVIS_I18N_DIR", previous);
            else qunsetenv("JARVIS_I18N_DIR");
        });
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
        jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-greeter"_s});
        QVERIFY(language.setLanguage(u"ar"_s));
        Fixture f;
        f.login->setSessions(readSessions(kSessions));
        f.login->setSessionId(u"rafiq-classic"_s);
        QCOMPARE(f.startedCommand(), (QJsonArray{u"labwc"_s, u"-C"_s, u"/etc/xdg/labwc-classic"_s}));
        QCOMPARE(f.greetd.received.last().value("env").toArray(), QJsonArray{u"LANG=ar_EG.UTF-8"_s});
        QVERIFY(language.setLanguage(u"en"_s));
    }

    void selectionIsLockedDuringLogin()
    {
        Fixture f;
        f.login->setSessions(readSessions(kSessions));
        QSignalSpy started(f.login.get(), &LoginModel::sessionStarted);
        f.login->submit(u"right horse"_s);
        f.login->setSessionId(u"rafiq-classic"_s);
        QCOMPARE(f.login->sessionId(), u"rafiq"_s);
        QVERIFY(started.wait(3000));
        QCOMPARE(f.greetd.received.last().value("cmd").toArray(), QJsonArray{u"labwc"_s});
    }

    void noSessionFilesStartsLabwc()
    {
        Fixture f;
        f.login->setSessions(readSessions(u"/nonexistent/sessions"_s));
        QVERIFY(f.login->sessions().isEmpty());
        QCOMPARE(f.startedCommand(), QJsonArray{u"labwc"_s});
    }
};

QTEST_MAIN(TestSessionChoice)
#include "tst_sessionchoice.moc"
