#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>

#include "models/SystemModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject snapshot(const QJsonValue& updates, const QJsonValue& download)
{
    QJsonObject model{{"kind", "ollama"}, {"model", "qwen3:8b"}, {"local", true}, {"supportsTools", true}};
    if (!download.isUndefined())
        model.insert("download", download);
    QJsonObject out{{"online", true}, {"network", QJsonObject{{"connectivity", "full"}, {"wifiSsid", QJsonValue::Null}}},
                    {"memTotalBytes", 0}, {"memUsedBytes", 0}, {"disk", QJsonObject{}}, {"failedUnits", QJsonArray{}},
                    {"model", model}};
    if (!updates.isUndefined())
        out.insert("updates", updates);
    return out;
}
} // namespace

class TestSystemUpdates : public QObject {
    Q_OBJECT
private slots:
    void updatesFromTheSnapshot()
    {
        SystemModel m;
        m.applySnapshot(snapshot(QJsonObject{{"count", 3}, {"security", 1}, {"checkedAt", 1759900000000.0}}, QJsonValue::Undefined));
        QCOMPARE(m.updatesCount(), 3);
        QCOMPARE(m.updatesSecurity(), 1);
        QCOMPARE(m.updatesText(), u"3 updates · 1 security"_s);
        m.applySnapshot(snapshot(QJsonObject{{"count", 1}, {"security", 0}, {"checkedAt", QJsonValue::Null}}, QJsonValue::Undefined));
        QCOMPARE(m.updatesText(), u"1 update"_s);
    }

    void oldDaemonsWithoutUpdatesMeanZero()
    {
        SystemModel m;
        m.applySnapshot(snapshot(QJsonValue::Undefined, QJsonValue::Undefined));
        QCOMPARE(m.updatesCount(), 0);
        QCOMPARE(m.updatesText(), QString());
        QCOMPARE(m.modelDownloadState(), QString());
        QCOMPARE(m.modelDownloadText(), QString());
    }

    void nonsenseCountsAreClamped()
    {
        SystemModel m;
        m.applySnapshot(snapshot(QJsonObject{{"count", -4}, {"security", 9}}, QJsonValue::Undefined));
        QCOMPARE(m.updatesCount(), 0);
        QCOMPARE(m.updatesSecurity(), 0);
        m.applyUpdateCounts(2, 5);
        QCOMPARE(m.updatesSecurity(), 2);
    }

    void modelDownload()
    {
        SystemModel m;
        m.applySnapshot(snapshot(QJsonValue::Undefined, QJsonObject{{"state", "downloading"}, {"percent", 42}}));
        QCOMPARE(m.modelDownloadState(), u"downloading"_s);
        QCOMPARE(m.modelDownloadPercent(), 42);
        QCOMPARE(m.modelDownloadText(), u"Downloading · 42%"_s);
        m.applySnapshot(snapshot(QJsonValue::Undefined, QJsonObject{{"state", "pending"}, {"percent", 0}}));
        QCOMPARE(m.modelDownloadText(), u"Waiting for the network to download"_s);
        m.applySnapshot(snapshot(QJsonValue::Undefined, QJsonObject{{"state", "failed"}, {"percent", 140}}));
        QCOMPARE(m.modelDownloadPercent(), 100);
        QCOMPARE(m.modelDownloadText(), u"Download failed. It will try again."_s);
        m.applySnapshot(snapshot(QJsonValue::Undefined, QJsonObject{{"state", "ready"}, {"percent", 100}}));
        QCOMPARE(m.modelDownloadText(), QString());
        m.reset();
        QCOMPARE(m.modelDownloadState(), QString());
        QCOMPARE(m.updatesCount(), 0);
    }
};

QTEST_GUILESS_MAIN(TestSystemUpdates)
#include "tst_systemupdates.moc"
