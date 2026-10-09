#include <QJsonDocument>
#include <QtTest>
#include <cstring>

#include "GreetdCodec.h"

using namespace Qt::StringLiterals;
using namespace jarvis::greeter;

class TestGreetdCodec : public QObject {
    Q_OBJECT
private slots:
    void lengthIsNativeEndian()
    {
        const QJsonObject message{{"type", "create_session"}, {"username", "mohamed"}};
        const QByteArray frame = encodeGreetd(message);
        const QByteArray payload = QJsonDocument(message).toJson(QJsonDocument::Compact);
        quint32 length = 0;
        std::memcpy(&length, frame.constData(), 4);
        QCOMPARE(length, quint32(payload.size()));
        QCOMPARE(frame.mid(4), payload);
    }

    void decodesAcrossChunksAndBackToBack()
    {
        const QByteArray a = encodeGreetd({{"type", "success"}});
        const QByteArray b = encodeGreetd({{"type", "auth_message"}, {"auth_message_type", "secret"}, {"auth_message", "Password:"}});
        GreetdDecoder decoder;
        const QByteArray both = a + b;
        for (char c : both.left(3))
            decoder.feed(QByteArray(1, c));
        QVERIFY(!decoder.next().has_value());
        decoder.feed(both.mid(3));
        QCOMPARE(decoder.next()->value("type").toString(), u"success"_s);
        QCOMPARE(decoder.next()->value("auth_message").toString(), u"Password:"_s);
        QVERIFY(!decoder.next().has_value());
        QVERIFY(!decoder.failed());
    }

    void tooLargeFails()
    {
        GreetdDecoder decoder;
        const quint32 huge = 1u << 20;
        decoder.feed(QByteArray(reinterpret_cast<const char*>(&huge), 4));
        QVERIFY(!decoder.next().has_value());
        QVERIFY(decoder.failed());
    }

    void garbageFails()
    {
        GreetdDecoder decoder;
        const QByteArray junk = "not json";
        const quint32 n = quint32(junk.size());
        decoder.feed(QByteArray(reinterpret_cast<const char*>(&n), 4) + junk);
        QVERIFY(!decoder.next().has_value());
        QVERIFY(decoder.failed());
        QVERIFY(!decoder.error().isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestGreetdCodec)
#include "tst_greetdcodec.moc"
