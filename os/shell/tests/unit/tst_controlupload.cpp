#include <QJsonArray>
#include <QJsonObject>
#include <QtTest>
#include <memory>
#include <optional>

#include "FakeDaemon.h"
#include "control/ControlClient.h"

using namespace Qt::StringLiterals;

namespace {
std::unique_ptr<ControlClient> makeClient(FakeDaemon& daemon)
{
    ControlOptions options;
    options.socketPath = daemon.socketPath();
    options.secretPath = daemon.secretPath();
    options.backoffMs = {20};
    return std::make_unique<ControlClient>(options);
}

bool open(ControlClient& client)
{
    client.start();
    return QTest::qWaitFor([&] { return client.state() == ControlClient::State::Open; }, 3000);
}

QByteArray pattern(qsizetype size)
{
    QByteArray bytes(size, Qt::Uninitialized);
    for (qsizetype i = 0; i < size; ++i)
        bytes[i] = char((i * 31) % 251);
    return bytes;
}
} // namespace

class TestControlUpload : public QObject {
    Q_OBJECT
private slots:
    void sendsHeaderThenChunks()
    {
        FakeDaemon daemon;
        daemon.handler = [](const QString& channel, const QJsonArray&, quint64) -> FakeDaemon::Reply {
            if (channel == u"voice:utterance")
                return {true, QJsonObject{{"text", "hello"}, {"lang", "en"}, {"action", "prompt"}}};
            return {};
        };
        QVERIFY(daemon.listen());
        auto client = makeClient(daemon);
        QVERIFY(open(*client));

        const QByteArray body = pattern(600'000); // 3 chunks: 262144 + 262144 + 75712
        std::optional<ControlResult> got;
        client->upload(u"voice:utterance"_s, QJsonArray{QJsonObject{{"lang", "auto"}}}, body,
                       [&](const ControlResult& r) { got = r; });
        QTRY_VERIFY(got.has_value());
        QVERIFY(got->ok);
        QCOMPARE(got->value.toObject().value("text").toString(), u"hello"_s);
        QCOMPARE(daemon.uploads.size(), 1);
        QCOMPARE(daemon.uploads[0].channel, u"voice:utterance"_s);
        QCOMPARE(daemon.uploads[0].chunks, 3);
        QCOMPARE(daemon.uploads[0].bytes, body);
        QCOMPARE(daemon.uploads[0].args.at(0).toObject().value("lang").toString(), u"auto"_s);
    }

    void refusesEmptyAndOversizedBodies()
    {
        FakeDaemon daemon;
        QVERIFY(daemon.listen());
        auto client = makeClient(daemon);
        QVERIFY(open(*client));
        std::optional<ControlResult> empty, huge;
        client->upload(u"voice:utterance"_s, {}, QByteArray(), [&](const ControlResult& r) { empty = r; });
        client->upload(u"voice:utterance"_s, {}, QByteArray(ControlClient::kMaxBlobBytes + 1, 'x'),
                       [&](const ControlResult& r) { huge = r; });
        QTRY_VERIFY(empty.has_value() && huge.has_value());
        QCOMPARE(empty->code, u"bad-request"_s);
        QCOMPARE(huge->code, u"bad-request"_s);
        QVERIFY(daemon.uploads.isEmpty());
        QCOMPARE(client->state(), ControlClient::State::Open);
    }

    void failsClosedWithoutAConnection()
    {
        FakeDaemon daemon; // never started
        auto client = makeClient(daemon);
        std::optional<ControlResult> got;
        client->upload(u"voice:utterance"_s, {}, pattern(100), [&](const ControlResult& r) { got = r; });
        QTRY_VERIFY(got.has_value());
        QVERIFY(!got->ok);
        QCOMPARE(got->code, u"closed"_s);
    }

    void dropMidReplyFailsThePendingUpload()
    {
        FakeDaemon daemon;
        daemon.handler = [](const QString&, const QJsonArray&, quint64) -> FakeDaemon::Reply {
            FakeDaemon::Reply reply;
            reply.defer = true;
            return reply;
        };
        QVERIFY(daemon.listen());
        auto client = makeClient(daemon);
        QVERIFY(open(*client));
        std::optional<ControlResult> got;
        client->upload(u"voice:utterance"_s, {}, pattern(1000), [&](const ControlResult& r) { got = r; });
        QTRY_COMPARE(daemon.uploads.size(), 1);
        daemon.dropClients();
        QTRY_VERIFY(got.has_value());
        QCOMPARE(got->code, u"closed"_s);
    }

    void requestsStillWorkAfterAnUpload()
    {
        FakeDaemon daemon;
        daemon.handler = [](const QString& channel, const QJsonArray&, quint64) -> FakeDaemon::Reply {
            return {true, channel == u"audit:list" ? QJsonValue(QJsonArray{}) : QJsonValue(QJsonObject{{"ok", true}})};
        };
        QVERIFY(daemon.listen());
        auto client = makeClient(daemon);
        QVERIFY(open(*client));
        std::optional<ControlResult> first, second;
        client->upload(u"voice:utterance"_s, {}, pattern(262'144), [&](const ControlResult& r) { first = r; });
        client->invoke(u"audit:list"_s, QJsonArray{QJsonObject{{"limit", 1}}}, [&](const ControlResult& r) { second = r; });
        QTRY_VERIFY(first.has_value() && second.has_value());
        QVERIFY(first->ok);
        QVERIFY(second->ok);
        QCOMPARE(daemon.uploads[0].chunks, 1);
    }
};

QTEST_GUILESS_MAIN(TestControlUpload)
#include "tst_controlupload.moc"
