#include <QtTest>
#include <memory>

#include "FakeDaemon.h"
#include "control/ControlClient.h"
#include "report/LanguageFollower.h"

using namespace Qt::StringLiterals;

class TestLanguageFollower : public QObject {
    Q_OBJECT
private slots:
    void followsLanguagePushes()
    {
        FakeDaemon daemon;
        daemon.listen();
        ControlOptions options;
        options.socketPath = daemon.socketPath();
        options.secretPath = daemon.secretPath();
        ControlClient client(options);
        QStringList applied;
        LanguageFollower follower(&client, [&](const QString& code) { applied << code; return true; });
        client.start();
        QVERIFY(QTest::qWaitFor([&] { return client.state() == ControlClient::State::Open; }, 3000));
        daemon.sendPush(u"ui:language"_s, QJsonObject{{"lang", "ar"}});
        QTRY_COMPARE(applied, QStringList{u"ar"_s});
        QVERIFY(daemon.requests(u"ui:setLanguage"_s).isEmpty()); // the lock never asks
    }

    void lockIgnoresBadLanguagePush()
    {
        FakeDaemon daemon;
        daemon.listen();
        ControlOptions options;
        options.socketPath = daemon.socketPath();
        options.secretPath = daemon.secretPath();
        ControlClient client(options);
        QStringList applied;
        LanguageFollower follower(&client, [&](const QString& code) { applied << code; return true; });
        client.start();
        QVERIFY(QTest::qWaitFor([&] { return client.state() == ControlClient::State::Open; }, 3000));
        for (const QJsonValue& bad : {QJsonValue(QJsonObject{{"lang", "fr"}}), QJsonValue(QJsonObject{{"lang", 1}}),
                                      QJsonValue(QJsonObject{}), QJsonValue(u"ar"_s), QJsonValue(QJsonArray{"ar"})})
            daemon.sendPush(u"ui:language"_s, bad);
        daemon.sendPush(u"ui:language"_s, QJsonObject{{"lang", "en"}}); // a marker that the bad ones arrived
        QTRY_COMPARE(applied, QStringList{u"en"_s});
    }
};

QTEST_MAIN(TestLanguageFollower)
#include "tst_languagefollower.moc"
