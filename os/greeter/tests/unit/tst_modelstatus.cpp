#include <QDir>
#include <QSaveFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>

#include "ModelStatus.h"

using namespace Qt::StringLiterals;

class TestModelStatus : public QObject {
    Q_OBJECT
    QTemporaryDir m_dir;
    QString statePath() const { return m_dir.filePath(u"model-state.json"_s); }
    QString catalog() const { return QStringLiteral(JARVIS_GREETER_TEST_DATA "/catalog.json"); }
    void write(const QByteArray& json)
    {
        QSaveFile file(statePath()); // atomic like the real writer
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(json);
        QVERIFY(file.commit());
    }

private slots:
    void init() { QFile::remove(statePath()); }

    void readyNamesTheModelFromTheCatalog()
    {
        write(R"({"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"ready","percent":100,"message":"","updatedAt":"2026-10-08T08:00:00Z"})");
        ModelStatus status(statePath(), catalog());
        QVERIFY(status.shown());
        QVERIFY(status.ready());
        QCOMPARE(status.text(), u"Jarvis is ready · Qwen3 8B loaded"_s);
    }

    void downloadingShowsPercent()
    {
        write(R"({"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"downloading","percent":42,"message":"","updatedAt":"x"})");
        ModelStatus status(statePath(), catalog());
        QVERIFY(!status.ready());
        QCOMPARE(status.text(), u"Preparing Qwen3 8B · 42%"_s);
    }

    void percentIsClamped()
    {
        write(R"({"modelId":"x","ollamaTag":"mystery:7b","state":"pending","percent":250,"message":"","updatedAt":"x"})");
        ModelStatus status(statePath(), catalog());
        QCOMPARE(status.text(), u"Preparing mystery:7b · 100%"_s); // unknown to the catalog: the tag
    }

    void failedSaysItWillRetry()
    {
        write(R"({"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"failed","percent":10,"message":"offline","updatedAt":"x"})");
        ModelStatus status(statePath(), catalog());
        QCOMPARE(status.text(), u"Jarvis couldn't download Qwen3 8B yet. It will try again."_s);
    }

    void garbageAndMissingStateHideTheLine()
    {
        ModelStatus missing(statePath(), catalog());
        QVERIFY(!missing.shown());
        write("{\"modelId\": \"qwen3-8b\", \"sta"); // half-written
        ModelStatus half(statePath(), catalog());
        QVERIFY(!half.shown());
        write(R"({"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"exploded","percent":1})");
        ModelStatus unknown(statePath(), catalog());
        QVERIFY(!unknown.shown());
        ModelStatus noCatalog(statePath(), u"/nonexistent.json"_s);
        QVERIFY(!noCatalog.shown());
    }

    void followsTheFileWhenItAppearsAndChanges()
    {
        ModelStatus status(statePath(), catalog());
        QSignalSpy changed(&status, &ModelStatus::changed);
        write(R"({"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"downloading","percent":10})");
        QTRY_VERIFY_WITH_TIMEOUT(status.shown(), 7000);
        write(R"({"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"ready","percent":100})");
        QTRY_VERIFY_WITH_TIMEOUT(status.ready(), 7000);
        QVERIFY(changed.size() >= 2);
    }

    void defaultPathsHonourTheEnvironment()
    {
        QCOMPARE(ModelStatus::defaultStatePath(), u"/var/lib/jarvis/model-state.json"_s);
        QCOMPARE(ModelStatus::defaultCatalogPath(), u"/usr/share/jarvis/models/catalog.json"_s);
        qputenv("JARVIS_MODEL_STATE", "/tmp/s.json");
        QCOMPARE(ModelStatus::defaultStatePath(), u"/tmp/s.json"_s);
        qunsetenv("JARVIS_MODEL_STATE");
    }
};

QTEST_GUILESS_MAIN(TestModelStatus)
#include "tst_modelstatus.moc"
