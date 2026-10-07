#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>

#include "models/ProviderModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject probeResult(bool ok, bool tools, const QStringList& models, const QString& error = {})
{
    QJsonObject out{{"ok", ok}, {"supportsTools", tools}, {"models", QJsonArray::fromStringList(models)}};
    if (!error.isEmpty())
        out.insert("error", error);
    return out;
}
QJsonObject list(const QJsonValue& active)
{
    return {{"active", active}, {"kinds", QJsonArray{"anthropic", "openai-compatible", "ollama"}}};
}
} // namespace

class TestProviderModel : public QObject {
    Q_OBJECT
private slots:
    void firstBootHasNoActiveProvider()
    {
        ProviderModel model;
        QVERIFY(!model.known());
        model.loadList(list(QJsonValue::Null));
        QVERIFY(model.known());
        QVERIFY(!model.hasActive());
        QCOMPARE(model.mode(), u"cloud"_s);
        QCOMPARE(model.preset(), u"Anthropic"_s);
        QCOMPARE(model.kind(), u"anthropic"_s);
        QCOMPARE(model.baseUrl(), u"https://api.anthropic.com"_s);
        QVERIFY(model.privacyText().contains(u"Anthropic"_s));
        QCOMPARE(model.presetNames().size(), 8);
    }

    void modesSetTheirDefaults()
    {
        ProviderModel model;
        model.setMode(u"local"_s);
        QCOMPARE(model.kind(), u"ollama"_s);
        QCOMPARE(model.baseUrl(), u"http://localhost:11434"_s);
        QCOMPARE(model.privacyText(), u"Diagnosis logs stay on your own machines."_s);
        QVERIFY(!model.needsKey());
        model.setMode(u"lan"_s);
        QCOMPARE(model.baseUrl(), QString());
        model.setMode(u"cloud"_s);
        model.setPreset(u"Groq"_s);
        QCOMPARE(model.kind(), u"openai-compatible"_s);
        QCOMPARE(model.baseUrl(), u"https://api.groq.com/openai/v1"_s);
        QVERIFY(model.needsKey());
    }

    void twoStepProbeThenSave()
    {
        ProviderModel model;
        QSignalSpy probes(&model, &ProviderModel::probeRequested);
        QSignalSpy saves(&model, &ProviderModel::saveRequested);
        QSignalSpy saved(&model, &ProviderModel::saved);
        model.setApiKey(u"sk-test"_s);
        model.probe();
        QCOMPARE(probes.size(), 1);
        const QJsonObject first = probes[0][0].toJsonObject();
        QCOMPARE(first, (QJsonObject{{"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"},
                                     {"model", ""}, {"apiKey", "sk-test"}}));
        QCOMPARE(model.probeState(), u"probing"_s);

        model.applyProbeResult(probeResult(false, false, {u"claude-a"_s, u"claude-b"_s}, u"model required"_s));
        QCOMPARE(model.model(), u"claude-a"_s);
        QCOMPARE(probes.size(), 2);
        QCOMPARE(probes[1][0].toJsonObject()["model"].toString(), u"claude-a"_s);

        model.applyProbeResult(probeResult(true, true, {u"claude-a"_s, u"claude-b"_s}));
        QCOMPARE(model.probeState(), u"ok"_s);
        QCOMPARE(model.statusText(), u"Connected to Anthropic. Tool calling works, so Jarvis can control this computer."_s);
        QVERIFY(model.canSave());

        model.save();
        QCOMPARE(saves.size(), 1);
        QCOMPARE(saves[0][0].toJsonObject()["apiKey"].toString(), u"sk-test"_s);
        QCOMPARE(model.probeState(), u"saving"_s);
        model.applySaveResult(probeResult(true, true, {u"claude-a"_s}));
        QCOMPARE(saved.size(), 1);
        QCOMPARE(model.apiKey(), QString());
    }

    void modelWithoutToolsIsAWarning()
    {
        ProviderModel model;
        model.setMode(u"local"_s);
        model.setModel(u"tiny"_s);
        model.probe();
        model.applyProbeResult(probeResult(true, false, {u"tiny"_s}));
        QCOMPARE(model.probeState(), u"warn"_s);
        QCOMPARE(model.statusText(), u"Connected to Ollama, but tiny can't call tools: Jarvis can chat but can't control the OS."_s);
        QVERIFY(model.canSave());
    }

    void connectedWithNoModelsExplainsItself()
    {
        ProviderModel model;
        model.setMode(u"local"_s);
        model.probe();
        model.applyProbeResult(probeResult(true, false, {}));
        QCOMPARE(model.statusText(), u"Connected to Ollama, but no models are available. Pull or enter a model first."_s);
        QVERIFY(!model.canSave());
    }

    void errorsBlockSaving()
    {
        ProviderModel model;
        model.setApiKey(u"sk-bad"_s);
        model.setModel(u"m"_s);
        model.probe();
        model.applyProbeResult(probeResult(false, false, {}, u"401 invalid x-api-key"_s));
        QCOMPARE(model.probeState(), u"error"_s);
        QCOMPARE(model.statusText(), u"401 invalid x-api-key"_s);
        QVERIFY(!model.canSave());
        QSignalSpy saves(&model, &ProviderModel::saveRequested);
        model.save();
        QCOMPARE(saves.size(), 0);
    }

    void missingInputsFailLocally()
    {
        ProviderModel model;
        QSignalSpy probes(&model, &ProviderModel::probeRequested);
        model.probe(); // cloud without a key
        QCOMPARE(probes.size(), 0);
        QCOMPARE(model.statusText(), u"Enter your API key first."_s);
        model.setMode(u"lan"_s);
        model.probe();
        QCOMPARE(probes.size(), 0);
        QCOMPARE(model.statusText(), u"Enter the server address first."_s);
    }

    void editingAFieldResetsTheProbe()
    {
        ProviderModel model;
        model.setMode(u"local"_s);
        model.setModel(u"qwen3:8b"_s);
        model.probe();
        model.applyProbeResult(probeResult(true, true, {u"qwen3:8b"_s}));
        QVERIFY(model.canSave());
        model.setBaseUrl(u"http://127.0.0.1:11434"_s);
        QCOMPARE(model.probeState(), u"idle"_s);
        QVERIFY(!model.canSave());
    }

    void staleProbeAnswersAreIgnored()
    {
        ProviderModel model;
        model.setMode(u"local"_s);
        model.applyProbeResult(probeResult(true, true, {u"x"_s}));
        QCOMPARE(model.probeState(), u"idle"_s);
    }

    void requestErrorsSurface()
    {
        ProviderModel model;
        model.setMode(u"local"_s);
        model.setModel(u"m"_s);
        model.probe();
        model.applyRequestError(u"Not connected to jarvisd"_s);
        QCOMPARE(model.probeState(), u"error"_s);
        QCOMPARE(model.statusText(), u"Not connected to jarvisd"_s);
    }

    void activeLabels_data()
    {
        QTest::addColumn<QString>("kind");
        QTest::addColumn<QString>("baseUrl");
        QTest::addColumn<QString>("label");
        QTest::addColumn<QString>("mode");
        QTest::addColumn<QString>("preset");
        QTest::newRow("ollama local") << u"ollama"_s << u"http://localhost:11434"_s << u"On this computer"_s << u"local"_s << QString();
        QTest::newRow("ollama lan") << u"ollama"_s << u"http://192.168.1.20:11434"_s << u"On your network"_s << u"lan"_s << QString();
        QTest::newRow("anthropic") << u"anthropic"_s << u"https://api.anthropic.com"_s << u"Anthropic"_s << u"cloud"_s << u"Anthropic"_s;
        QTest::newRow("groq") << u"openai-compatible"_s << u"https://api.groq.com/openai/v1"_s << u"Groq"_s << u"cloud"_s << u"Groq"_s;
        QTest::newRow("lm studio lan") << u"openai-compatible"_s << u"http://10.0.0.5:1234/v1"_s << u"On your network"_s << u"lan"_s << QString();
        QTest::newRow("custom cloud") << u"openai-compatible"_s << u"https://llm.example.com/v1"_s << u"llm.example.com"_s << u"cloud"_s << u"Custom URL"_s;
    }

    void activeLabels()
    {
        QFETCH(QString, kind);
        QFETCH(QString, baseUrl);
        QFETCH(QString, label);
        QFETCH(QString, mode);
        QFETCH(QString, preset);
        ProviderModel model;
        model.loadList(list(QJsonObject{{"kind", kind}, {"baseUrl", baseUrl}, {"model", "m1"}, {"hasKey", true}}));
        QVERIFY(model.hasActive());
        QCOMPARE(model.activeModel(), u"m1"_s);
        QCOMPARE(model.activeLabel(), label);
        model.editActive();
        QCOMPARE(model.mode(), mode);
        QCOMPARE(model.preset(), preset);
        QCOMPARE(model.baseUrl(), baseUrl);
        QCOMPARE(model.model(), u"m1"_s);
        QCOMPARE(model.apiKey(), QString());
    }

    void savedKeyIsKeptWhenTheFieldIsEmpty()
    {
        ProviderModel model;
        model.loadList(list(QJsonObject{{"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"},
                                        {"model", "claude-a"}, {"hasKey", true}}));
        model.editActive();
        QSignalSpy probes(&model, &ProviderModel::probeRequested);
        model.probe();
        QCOMPARE(probes.size(), 1);
        QVERIFY(!probes[0][0].toJsonObject().contains("apiKey"));
    }
};

QTEST_GUILESS_MAIN(TestProviderModel)
#include "tst_providermodel.moc"
