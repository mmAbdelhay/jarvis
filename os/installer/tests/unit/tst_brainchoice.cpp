#include <QtTest>

#include "BrainChoice.h"
#include "Fixtures.h"

using namespace Qt::StringLiterals;

class TestBrainChoice : public QObject {
    Q_OBJECT
private slots:
    void localIsRecommendedWhenAModelFits()
    {
        BrainChoice b;
        b.applyProbe(loadFixture(u"probe-windows.json"_s));
        b.setTargetBytes(147000000000);
        QCOMPARE(b.kind(), u"local"_s);
        QCOMPARE(b.modelId(), u"qwen3-8b"_s);
        QCOMPARE(b.models().size(), 2);
        QVERIFY(b.models().at(0).toMap().value(u"recommended"_s).toBool());
        QVERIFY(!b.models().at(1).toMap().value(u"recommended"_s).toBool());
        QCOMPARE(b.localTitle(), u"This computer — Qwen3 8B"_s);
        QCOMPARE(b.localDetail(), u"Everyday help. Private, works offline. 5.2 GB download during install."_s);
        QCOMPARE(b.ramText(), u"16 GB"_s);
        QCOMPARE(b.gpuText(), u"NVIDIA GeForce RTX 3060 · 6 GB"_s);
        QCOMPARE(b.freeText(), u"147 GB"_s);
        QVERIFY(b.valid());
        QCOMPARE(b.toJson(), (QJsonObject{{"kind", "local"}, {"modelId", "qwen3-8b"}}));
    }

    void shrinkingTheTargetDropsModelsAndKeepsAValidChoice()
    {
        BrainChoice b;
        b.applyProbe(loadFixture(u"probe-windows.json"_s));
        b.setTargetBytes(147000000000);
        b.setModelId(u"qwen3-4b"_s);
        b.setTargetBytes(25000000000);              // 4B (2.6 GB) + 20 GiB fits, 8B does not
        QCOMPARE(b.models().size(), 1);
        QCOMPARE(b.modelId(), u"qwen3-4b"_s);
        b.setTargetBytes(10000000000);              // nothing fits
        QVERIFY(!b.localAvailable());
        QCOMPARE(b.kind(), u"cloud"_s);
        QVERIFY(b.localDetail().startsWith(u"No tested model fits"_s));
        b.setKind(u"local"_s);
        QCOMPARE(b.kind(), u"cloud"_s);
    }

    void unknownModelIdIsIgnored()
    {
        BrainChoice b;
        b.applyProbe(loadFixture(u"probe-windows.json"_s));
        b.setTargetBytes(147000000000);
        b.setModelId(u"gpt-oss-20b"_s);             // in the catalog, but needs a 16 GB GPU
        QCOMPARE(b.modelId(), u"qwen3-8b"_s);
    }

    void hardwareEligibilityComesFromBackend()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        probe.insert("ramBytes", 1);
        probe.insert("gpu", QJsonValue::Null);
        BrainChoice b; b.applyProbe(probe); b.setTargetBytes(147000000000);
        QCOMPARE(b.models().size(), 2); // backend fits flags remain authoritative
        QCOMPARE(b.modelId(), u"qwen3-8b"_s);
    }

    void lanNeedsAnAddressAndAModel()
    {
        BrainChoice b;
        b.applyProbe(loadFixture(u"probe-windows.json"_s));
        b.setKind(u"lan"_s);
        QCOMPARE(b.blockText(), u"Enter the server address, like http://192.168.1.20:11434."_s);
        b.setLanUrl(u"ftp://box"_s);
        QVERIFY(!b.valid());
        b.setLanUrl(u" http://192.168.1.20:11434 "_s);
        QCOMPARE(b.blockText(), u"Enter the model name, like qwen3:8b."_s);
        b.setLanModel(u"qwen3:14b"_s);
        QVERIFY(b.valid());
        QCOMPARE(b.toJson(), (QJsonObject{{"kind", "lan"}, {"baseUrl", "http://192.168.1.20:11434"}, {"model", "qwen3:14b"}}));
    }

    void cloudIsAlwaysValid()
    {
        BrainChoice b;
        b.setKind(u"cloud"_s);
        QVERIFY(b.valid());
        QCOMPARE(b.toJson(), (QJsonObject{{"kind", "cloud"}}));
        QCOMPARE(b.gpuText(), u"None"_s);
    }
};

QTEST_GUILESS_MAIN(TestBrainChoice)
#include "tst_brainchoice.moc"
