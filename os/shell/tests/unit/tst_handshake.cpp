#include <QJsonArray>
#include <QTemporaryDir>
#include <QtTest>

#include "Vectors.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"
#include "protocol/Handshake.h"

using namespace jarvis::protocol;
using namespace Qt::StringLiterals;

namespace {
QByteArray sequence(int start)
{
    QByteArray out(32, '\0');
    for (int i = 0; i < 32; ++i)
        out[i] = char((start + i) & 0xff);
    return out;
}

void writeFile(const QString& path, const QByteArray& content)
{
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write(content);
}
} // namespace

class TestHandshake : public QObject {
    Q_OBJECT
private slots:
    void proofsMatchTypeScriptVectors()
    {
        for (const QJsonValue& entry : loadVectors()["proofs"].toArray()) {
            const QJsonObject v = entry.toObject();
            const QByteArray secret = QByteArray::fromHex(v["secret"].toString().toLatin1());
            const QByteArray nonceC = QByteArray::fromHex(v["nonceC"].toString().toLatin1());
            const QByteArray nonceS = QByteArray::fromHex(v["nonceS"].toString().toLatin1());
            QCOMPARE(serverProof(secret, nonceC, nonceS).toHex(), v["serverProof"].toString().toLatin1());
            QCOMPARE(clientProof(secret, nonceS, nonceC).toHex(), v["clientProof"].toString().toLatin1());
        }
    }

    // The same numbers pinned in source, so a regenerated vectors file cannot
    // silently move both sides at once.
    void pinnedVector()
    {
        const QByteArray secret = sequence(0x00), nonceC = sequence(0x20), nonceS = sequence(0x40);
        QCOMPARE(serverProof(secret, nonceC, nonceS).toHex(),
                 QByteArray("a6ee22b14072bf76d08764621a2cbcb0c0b495be8481fc3dec27e8c2c3e779e8"));
        QCOMPARE(clientProof(secret, nonceS, nonceC).toHex(),
                 QByteArray("8335ba320d028c687dc2453d50a3a957a1fcdec2787cfd8d1f292a80436ac715"));
    }

    void proofMatchesIsStrict()
    {
        const QByteArray expected = serverProof(sequence(0), sequence(0x20), sequence(0x40));
        const QString hex = QString::fromLatin1(expected.toHex());
        QVERIFY(proofMatches(expected, hex));
        QVERIFY(!proofMatches(expected, hex.toUpper()));
        QVERIFY(!proofMatches(expected, hex.left(62)));
        QString flipped = hex;
        flipped[63] = flipped[63] == u'0' ? u'1' : u'0';
        QVERIFY(!proofMatches(expected, flipped));
        QVERIFY(!proofMatches(expected, QString()));
    }

    void isHex32()
    {
        QVERIFY(jarvis::protocol::isHex32(QString(64, u'a')));
        QVERIFY(!jarvis::protocol::isHex32(QString(64, u'A')));
        QVERIFY(!jarvis::protocol::isHex32(QString(63, u'a')));
        QVERIFY(!jarvis::protocol::isHex32(QString(64, u'g')));
    }

    void parsesTheSecretFile()
    {
        const QByteArray hex = sequence(0).toHex();
        QCOMPARE(parseSecret(hex + "\n").value(), sequence(0));
        QCOMPARE(parseSecret("  " + hex + " \n").value(), sequence(0));
        QVERIFY(!parseSecret(hex.left(63)).has_value());
        QVERIFY(!parseSecret(hex.toUpper()).has_value());
        QVERIFY(!parseSecret(QByteArray(64, 'z')).has_value());
        QVERIFY(!parseSecret(QByteArray()).has_value());
    }

    void formatsBuildIdLikeTypeScript()
    {
        QCOMPARE(formatBuildId(u"0.4.0"_s, u"abc123def456"_s, u"2026-10-07T10:00:00.000Z"_s),
                 u"0.4.0+abc123def456.2026-10-07T10:00:00.000Z"_s);
        QCOMPARE(formatBuildId(u"0.4.0"_s, std::nullopt, u"T"_s), u"0.4.0+nogit.T"_s);
        QCOMPARE(formatBuildId(u"0.4.0"_s, u""_s, u"T"_s), u"0.4.0+.T"_s);
        QCOMPARE(formatBuildId(QString(300, u'v'), std::nullopt, u"T"_s).size(), 256);
    }

    void readsTheBuildStamp()
    {
        QTemporaryDir dir;
        const QString path = dir.filePath(u"build-stamp.json"_s);
        QCOMPARE(readBuildId(path), u"dev"_s); // missing
        // contracts §6.6: the OS daemon bundle ships {"build": string}
        writeFile(path, R"({"build":"0.4.0+abc123.2026-10-07T10:00:00.000Z"})");
        QCOMPARE(readBuildId(path), u"0.4.0+abc123.2026-10-07T10:00:00.000Z"_s);
        writeFile(path, QByteArray(R"({"build":")") + QByteArray(300, 'b') + "\"}");
        QCOMPARE(readBuildId(path).size(), 256);
        writeFile(path, R"({"build":""})");
        QCOMPARE(readBuildId(path), u"dev"_s);
        writeFile(path, R"({"build":42})");
        QCOMPARE(readBuildId(path), u"dev"_s);
        // the Jarvis app's dist/build-stamp.json shape (build-id.ts) still works
        writeFile(path, R"({"version":"0.4.0","commit":"abc","builtAt":"T1"})");
        QCOMPARE(readBuildId(path), u"0.4.0+abc.T1"_s);
        writeFile(path, R"({"version":"0.4.0","builtAt":"T1"})");
        QCOMPARE(readBuildId(path), u"0.4.0+nogit.T1"_s);
        writeFile(path, R"({"version":"0.4.0"})");
        QCOMPARE(readBuildId(path), u"dev"_s);
        writeFile(path, R"({"version":"0.4.0","commit":null,"builtAt":"T1"})");
        QCOMPARE(readBuildId(path), u"dev"_s);
        writeFile(path, "not json");
        QCOMPARE(readBuildId(path), u"dev"_s);
    }

    void buildStampPathCanBeOverridden()
    {
        qunsetenv("JARVIS_BUILD_STAMP");
        QCOMPARE(defaultBuildStampPath(), u"/usr/lib/jarvis/daemon/build-stamp.json"_s);
        qputenv("JARVIS_BUILD_STAMP", "/tmp/stamp.json");
        QCOMPARE(defaultBuildStampPath(), u"/tmp/stamp.json"_s);
        qunsetenv("JARVIS_BUILD_STAMP");
    }

    void controlPathsFollowEndpointTs()
    {
        const ControlPaths paths = controlPaths(u"/run/dir"_s);
        QCOMPARE(paths.runDirectory, u"/run/dir"_s);
        QCOMPARE(paths.socketPath, u"/run/dir/jarvisd.sock"_s);
        QCOMPARE(paths.secretPath, u"/run/dir/control.secret"_s);

        qputenv("JARVIS_RUN_DIR", "/tmp/jarvis-run");
        QCOMPARE(defaultRunDirectory(), u"/tmp/jarvis-run"_s);
        qunsetenv("JARVIS_RUN_DIR");
        QCOMPARE(defaultRunDirectory(), QDir::homePath() + u"/.config/jarvis/run"_s);
    }
};

QTEST_GUILESS_MAIN(TestHandshake)
#include "tst_handshake.moc"
