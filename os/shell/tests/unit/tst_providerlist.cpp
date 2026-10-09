#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>

#include "models/ProviderListModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject local()
{
    return {{"id", "local"}, {"kind", "ollama"}, {"baseUrl", "http://localhost:11434"}, {"model", "qwen3:8b"}, {"hasKey", false}};
}
QJsonObject work()
{
    return {{"id", "work"}, {"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"}, {"model", "claude-sonnet-5-5"}, {"hasKey", true}};
}
QJsonObject listOf(const QJsonArray& providers, const QJsonValue& activeId = QJsonValue::Null, bool fallback = false)
{
    return {{"providers", providers}, {"activeId", activeId}, {"allowCloudFallback", fallback},
            {"kinds", QJsonArray{"anthropic", "openai-compatible", "ollama", "gemini"}}};
}
QJsonObject probe(bool ok, const QString& error = {})
{
    QJsonObject out{{"ok", ok}, {"supportsTools", ok}, {"models", QJsonArray{}}};
    if (!error.isEmpty())
        out.insert("error", error);
    return out;
}
QString idAt(const ProviderListModel& m, int row) { return m.data(m.index(row), ProviderListModel::IdRole).toString(); }
} // namespace

class TestProviderList : public QObject {
    Q_OBJECT
private slots:
    void loadsTheOrderedListAndMarksTheActive()
    {
        ProviderListModel m;
        QAbstractItemModelTester tester(&m);
        m.loadList(listOf({local(), work()}, u"work"_s));
        QVERIFY(m.known());
        QCOMPARE(m.rowCount(), 2);
        QCOMPARE(idAt(m, 0), u"local"_s);
        QCOMPARE(m.data(m.index(0), ProviderListModel::LabelRole).toString(), u"On this computer"_s);
        QCOMPARE(m.data(m.index(1), ProviderListModel::ModeRole).toString(), u"cloud"_s);
        QVERIFY(!m.data(m.index(0), ProviderListModel::ActiveRole).toBool());
        QVERIFY(m.data(m.index(1), ProviderListModel::ActiveRole).toBool());
        QCOMPARE(m.activeId(), u"work"_s);
        QCOMPARE(m.displayName(u"work"_s), u"claude-sonnet-5-5 · Anthropic"_s);
        QVERIFY(!m.dirty());
    }

    void noActiveIdMeansTheFirst()
    {
        ProviderListModel m;
        m.loadList(listOf({local(), work()}));
        QCOMPARE(m.activeId(), u"local"_s);
    }

    void legacyActiveBecomesOneDefaultRow()
    {
        ProviderListModel m;
        m.loadList(QJsonObject{{"active", QJsonObject{{"kind", "ollama"}, {"baseUrl", "http://localhost:11434"}, {"model", "qwen3:8b"}, {"hasKey", false}}},
                               {"kinds", QJsonArray{}}});
        QCOMPARE(m.rowCount(), 1);
        QCOMPARE(idAt(m, 0), u"default"_s);
    }

    void reorderAndToggleMakeItDirtyAndSaveSendsThePayload()
    {
        ProviderListModel m;
        QAbstractItemModelTester tester(&m);
        QSignalSpy saves(&m, &ProviderListModel::saveRequested);
        m.loadList(listOf({local(), work()}));
        m.moveDown(0);
        QCOMPARE(idAt(m, 0), u"work"_s);
        m.moveUp(0); // already first: nothing happens
        QCOMPARE(idAt(m, 0), u"work"_s);
        m.setAllowCloudFallback(true);
        QVERIFY(m.dirty());
        m.save();
        QCOMPARE(saves.size(), 1);
        const QJsonObject payload = saves.first().first().value<QJsonObject>();
        QCOMPARE(payload, (QJsonObject{
            {"providers", QJsonArray{
                QJsonObject{{"id", "work"}, {"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"}, {"model", "claude-sonnet-5-5"}},
                QJsonObject{{"id", "local"}, {"kind", "ollama"}, {"baseUrl", "http://localhost:11434"}, {"model", "qwen3:8b"}}}},
            {"allowCloudFallback", true}}));
        QVERIFY(m.saving());
        m.save(); // a second click while saving sends nothing
        QCOMPARE(saves.size(), 1);
    }

    void theLastProviderCannotBeRemoved()
    {
        ProviderListModel m;
        m.loadList(listOf({local(), work()}));
        m.remove(0);
        QCOMPARE(m.rowCount(), 1);
        m.remove(0);
        QCOMPARE(m.rowCount(), 1);
        QCOMPARE(m.statusText(), u"Jarvis needs at least one provider."_s);
    }

    void aFailedProviderBlocksTheSaveAndShowsItsError()
    {
        ProviderListModel m;
        QSignalSpy saved(&m, &ProviderListModel::saved);
        m.loadList(listOf({local(), work()}));
        m.moveDown(0);
        m.save();
        m.applySaveResult(QJsonObject{{"ok", false}, {"results", QJsonObject{{"local", probe(true)}, {"work", probe(false, u"401 invalid x-api-key"_s)}}}});
        QCOMPARE(saved.size(), 0);
        QVERIFY(m.dirty());
        QVERIFY(!m.saving());
        QCOMPARE(m.data(m.index(0), ProviderListModel::ErrorRole).toString(), u"401 invalid x-api-key"_s);
        QCOMPARE(m.data(m.index(1), ProviderListModel::ErrorRole).toString(), QString());
        QVERIFY(m.statusText().contains(u"work"_s));
        m.save();
        m.applySaveResult(QJsonObject{{"ok", true}, {"results", QJsonObject{{"local", probe(true)}, {"work", probe(true)}}}});
        QCOMPARE(saved.size(), 1);
        QVERIFY(!m.dirty());
        QCOMPARE(m.data(m.index(0), ProviderListModel::ErrorRole).toString(), QString());
    }

    void payloadWithReplacesOrAppendsTheDraft()
    {
        ProviderListModel m;
        m.loadList(listOf({local(), work()}));
        QJsonObject edited{{"id", "work"}, {"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"}, {"model", "claude-b"}, {"apiKey", "sk-new"}};
        QJsonArray providers = m.payloadWith(edited).value("providers").toArray();
        QCOMPARE(providers.size(), 2);
        QCOMPARE(providers.at(1).toObject(), edited);
        QJsonObject added{{"id", "lan"}, {"kind", "ollama"}, {"baseUrl", "http://192.168.1.20:11434"}, {"model", "qwen3:32b"}};
        providers = m.payloadWith(added).value("providers").toArray();
        QCOMPARE(providers.size(), 3);
        QCOMPARE(providers.at(2).toObject(), added);
    }

    void resultForPicksTheEditedProvider()
    {
        const QJsonObject both{{"ok", true}, {"results", QJsonObject{{"local", probe(true)}, {"work", probe(true)}}}};
        QVERIFY(ProviderListModel::resultFor(both, u"work"_s).value("ok").toBool());
        const QJsonObject other{{"ok", false}, {"results", QJsonObject{{"local", probe(false, u"connect ECONNREFUSED"_s)}, {"work", probe(true)}}}};
        const QJsonObject r = ProviderListModel::resultFor(other, u"work"_s);
        QVERIFY(!r.value("ok").toBool());
        QVERIFY(r.value("error").toString().contains(u"local"_s));
        const QJsonObject legacy = probe(true);
        QCOMPARE(ProviderListModel::resultFor(legacy, u"work"_s), legacy);
    }

    void uniqueIdAvoidsTakenIds()
    {
        ProviderListModel m;
        m.loadList(listOf({local()}));
        QCOMPARE(m.uniqueId(u"local"_s), u"local-2"_s);
        QCOMPARE(m.uniqueId(u"anthropic"_s), u"anthropic"_s);
        QCOMPARE(m.uniqueId(QString()), u"provider"_s);
    }

    void statusMovesTheActiveMark()
    {
        ProviderListModel m;
        m.loadList(listOf({local(), work()}, u"local"_s));
        m.setActiveId(u"work"_s);
        QVERIFY(m.data(m.index(1), ProviderListModel::ActiveRole).toBool());
        QCOMPARE(m.configFor(u"work"_s).value("model").toString(), u"claude-sonnet-5-5"_s);
        QVERIFY(m.configFor(u"gone"_s).isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestProviderList)
#include "tst_providerlist.moc"
