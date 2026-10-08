#include <QSignalSpy>
#include <QtTest>

#include "FakeGreetd.h"
#include "GreetdClient.h"

using namespace Qt::StringLiterals;

class TestGreetdClient : public QObject {
    Q_OBJECT
private slots:
    void requestAndResponse()
    {
        FakeGreetd greetd;
        QVERIFY(greetd.listen());
        GreetdClient client(greetd.socketPath());
        QSignalSpy responses(&client, &GreetdClient::response);
        client.send({{"type", "create_session"}, {"username", "mohamed"}});
        QTRY_COMPARE(responses.size(), 1);
        QCOMPARE(responses.at(0).at(0).toJsonObject().value("auth_message_type").toString(), u"secret"_s);
        QCOMPARE(greetd.received.at(0).value("username").toString(), u"mohamed"_s);
    }

    void missingSocketIsReported()
    {
        GreetdClient client(u"/tmp/no-such-greetd.sock"_s);
        QSignalSpy failed(&client, &GreetdClient::failed);
        client.send({{"type", "create_session"}, {"username", "x"}});
        QTRY_COMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"The login service isn't running."_s);
        GreetdClient unset{QString()};
        QSignalSpy failedUnset(&unset, &GreetdClient::failed);
        unset.send({{"type", "cancel_session"}});
        QTRY_COMPARE(failedUnset.size(), 1);
    }

    void reconnectsAfterTheServerDrops()
    {
        FakeGreetd greetd;
        QVERIFY(greetd.listen());
        GreetdClient client(greetd.socketPath());
        QSignalSpy responses(&client, &GreetdClient::response);
        QSignalSpy failed(&client, &GreetdClient::failed);
        greetd.dropOnCreate = true;
        client.send({{"type", "create_session"}, {"username", "mohamed"}});
        QTRY_COMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"Lost the connection to the login service."_s);
        greetd.dropOnCreate = false;
        client.send({{"type", "create_session"}, {"username", "mohamed"}});
        QTRY_COMPARE(responses.size(), 1);
        QCOMPARE(failed.size(), 1);
    }

    void socketPathComesFromTheEnvironment()
    {
        qputenv("GREETD_SOCK", "/run/greetd-1.sock");
        QCOMPARE(GreetdClient::socketPathFromEnvironment(), u"/run/greetd-1.sock"_s);
        qunsetenv("GREETD_SOCK");
        QCOMPARE(GreetdClient::socketPathFromEnvironment(), QString());
    }
};

QTEST_GUILESS_MAIN(TestGreetdClient)
#include "tst_greetdclient.moc"
