#include <QJsonArray>
#include <QtEndian>
#include <QtTest>

#include "Vectors.h"
#include "protocol/FrameCodec.h"

using namespace jarvis::protocol;

namespace {
QByteArray fromHexField(const QJsonObject& object, const char* key)
{
    return QByteArray::fromHex(object.value(QLatin1StringView(key)).toString().toLatin1());
}

QByteArray rawJsonFrame(const QByteArray& payload)
{
    QByteArray wire(kFrameHeaderBytes, '\0');
    qToBigEndian<quint32>(quint32(payload.size()), wire.data());
    wire[4] = 0;
    return wire + payload;
}
} // namespace

class TestFrameCodec : public QObject {
    Q_OBJECT
private slots:
    void constantsMatchTypeScript()
    {
        const QJsonObject vectors = loadVectors();
        QCOMPARE(vectors["protocolVersion"].toInt(), kControlProtocolVersion);
        QCOMPARE(qint64(vectors["maxFrameBytes"].toDouble()), qint64(kMaxControlFrameBytes));
        QCOMPARE(vectors["maxHelloFrameBytes"].toInt(), int(kMaxHelloFrameBytes));
    }

    void encodesSortedKeyFramesLikeTypeScript()
    {
        const QJsonArray frames = loadVectors()["jsonFrames"].toArray();
        for (int i = 0; i < 2; ++i) {
            const QJsonObject vector = frames[i].toObject();
            QCOMPARE(encodeJsonFrame(vector["value"].toObject()), fromHexField(vector, "hex"));
        }
    }

    void decodesEveryJsonVector()
    {
        for (const QJsonValue& entry : loadVectors()["jsonFrames"].toArray()) {
            const QJsonObject vector = entry.toObject();
            FrameDecoder decoder(kMaxControlFrameBytes);
            decoder.push(fromHexField(vector, "hex"));
            const auto frame = decoder.next();
            QVERIFY(frame.has_value());
            QVERIFY(frame->kind == FrameKind::Json);
            QCOMPARE(frame->json, vector["value"].toObject());
            QVERIFY(!decoder.next().has_value());
            QVERIFY(decoder.error() == FrameError::None);
            QCOMPARE(decoder.bufferedBytes(), 0);
        }
    }

    void binaryVectorRoundTrips()
    {
        const QJsonObject vector = loadVectors()["binaryFrames"].toArray()[0].toObject();
        const QByteArray bytes = fromHexField(vector, "bytes");
        QCOMPARE(encodeBinaryFrame(bytes), fromHexField(vector, "hex"));
        FrameDecoder decoder(kMaxControlFrameBytes);
        decoder.push(fromHexField(vector, "hex"));
        const auto frame = decoder.next();
        QVERIFY(frame.has_value());
        QVERIFY(frame->kind == FrameKind::Binary);
        QCOMPARE(frame->bytes, bytes);
    }

    void decodesByteByByte()
    {
        const QJsonObject value{{"t", "res"}, {"id", 3}, {"v", "ok"}};
        const QByteArray wire = encodeJsonFrame(value);
        FrameDecoder decoder(kMaxControlFrameBytes);
        for (qsizetype i = 0; i + 1 < wire.size(); ++i) {
            decoder.push(wire.mid(i, 1));
            QVERIFY(!decoder.next().has_value());
        }
        decoder.push(wire.right(1));
        const auto frame = decoder.next();
        QVERIFY(frame.has_value());
        QCOMPARE(frame->json, value);
    }

    void decodesTwoFramesFromOneChunk()
    {
        FrameDecoder decoder(kMaxControlFrameBytes);
        decoder.push(encodeJsonFrame({{"n", 1}}) + encodeJsonFrame({{"n", 2}}));
        QCOMPARE(decoder.next()->json["n"].toInt(), 1);
        QCOMPARE(decoder.next()->json["n"].toInt(), 2);
        QVERIFY(!decoder.next().has_value());
        QCOMPARE(decoder.bufferedBytes(), 0);
    }

    void acceptsAnEmptyBinaryFrame()
    {
        FrameDecoder decoder(kMaxControlFrameBytes);
        decoder.push(QByteArray::fromHex("0000000001"));
        const auto frame = decoder.next();
        QVERIFY(frame.has_value());
        QVERIFY(frame->kind == FrameKind::Binary);
        QVERIFY(frame->bytes.isEmpty());
    }

    void rejectsUnknownKind()
    {
        FrameDecoder decoder(kMaxControlFrameBytes);
        decoder.push(QByteArray::fromHex("000000010261"));
        QVERIFY(!decoder.next().has_value());
        QVERIFY(decoder.error() == FrameError::UnknownKind);
    }

    void rejectsOversizeBeforeThePayloadArrives()
    {
        FrameDecoder decoder(kMaxHelloFrameBytes);
        decoder.push(QByteArray::fromHex("0000100100")); // declares 4097 bytes, sends none
        QVERIFY(!decoder.next().has_value());
        QVERIFY(decoder.error() == FrameError::TooLarge);
    }

    void rejectsAnEmptyJsonFrame()
    {
        FrameDecoder decoder(kMaxControlFrameBytes);
        decoder.push(QByteArray::fromHex("0000000000"));
        QVERIFY(!decoder.next().has_value());
        QVERIFY(decoder.error() == FrameError::Empty);
    }

    void rejectsMalformedAndNonObjectJson()
    {
        for (const QByteArray& payload : {QByteArray("{"), QByteArray("[1]"), QByteArray("null")}) {
            FrameDecoder decoder(kMaxControlFrameBytes);
            decoder.push(rawJsonFrame(payload));
            QVERIFY(!decoder.next().has_value());
            QVERIFY(decoder.error() == FrameError::Malformed);
        }
    }

    void raisedLimitAppliesToTheNextHeader()
    {
        QJsonObject big{{"blob", QString(5000, u'x')}};
        FrameDecoder decoder(kMaxHelloFrameBytes);
        decoder.setMaxBytes(kMaxControlFrameBytes);
        decoder.push(encodeJsonFrame(big));
        const auto frame = decoder.next();
        QVERIFY(frame.has_value());
        QCOMPARE(frame->json, big);
    }

    void errorIsSticky()
    {
        FrameDecoder decoder(kMaxControlFrameBytes);
        decoder.push(QByteArray::fromHex("000000010261"));
        QVERIFY(!decoder.next().has_value());
        decoder.push(encodeJsonFrame({{"n", 1}}));
        QVERIFY(!decoder.next().has_value());
        QVERIFY(decoder.error() == FrameError::UnknownKind);
    }
};

QTEST_GUILESS_MAIN(TestFrameCodec)
#include "tst_framecodec.moc"
