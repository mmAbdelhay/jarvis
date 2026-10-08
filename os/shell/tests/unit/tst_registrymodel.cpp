#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QJsonObject>
#include <QSignalSpy>
#include <QtTest>

#include "models/RegistryModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject entry(const QString& id, const QString& version, const QString& tier, bool network = false,
                  const QJsonArray& paths = {})
{
    return {{"id", id}, {"name", id}, {"description", u"Does "_s + id}, {"tier", tier}, {"version", version},
            {"artifact", QJsonObject{{"url", u"https://example.invalid/"_s + id}, {"sha256", QString(64, u'a')}, {"runtime", "go-static"}}},
            {"permissions", QJsonObject{{"network", network}, {"paths", paths}}},
            {"tools", QJsonArray{QJsonObject{{"name", id + u".run"_s}, {"risk", "safe"}}}}};
}
QJsonObject sample()
{
    return {{"installed", QJsonArray{entry(u"jarvis-clock"_s, u"1.0.0"_s, u"official"_s), entry(u"old-tool"_s, u"0.1"_s, u"reviewed"_s)}},
            {"available", QJsonArray{entry(u"jarvis-clock"_s, u"1.1.0"_s, u"official"_s),
                                     entry(u"jarvis-web"_s, u"1.0.0"_s, u"official"_s, true),
                                     entry(u"weather"_s, u"0.3"_s, u"community"_s, true, QJsonArray{"~/Documents/weather"})}}};
}
QVariant at(const RegistryModel& m, int row, int role) { return m.data(m.index(row), role); }
} // namespace

class TestRegistryModel : public QObject {
    Q_OBJECT
private slots:
    void rejectsReservedPrefixOutsideOfficialTier()
    {
        RegistryModel m;
        m.applyList(QJsonObject{{"available", QJsonArray{
            entry(u"jarvis-untrusted"_s, u"1"_s, u"community"_s),
            entry(u"jarvis-reviewed"_s, u"1"_s, u"reviewed"_s)}}});
        QCOMPARE(m.count(), 0);
    }

    void rejectsTrailingNewlines()
    {
        QVERIFY(!RegistryModel::validId(u"tool\n"_s));
        QVERIFY(!RegistryModel::validVersion(u"1\n"_s));
    }
    void mergesInstalledAndAvailable()
    {
        RegistryModel m;
        QAbstractItemModelTester tester(&m);
        m.applyList(sample());
        QCOMPARE(m.count(), 4);
        QCOMPARE(at(m, 0, RegistryModel::EntryIdRole).toString(), u"jarvis-clock"_s);
        QCOMPARE(at(m, 0, RegistryModel::InstallStateRole).toString(), u"update"_s);
        QCOMPARE(at(m, 0, RegistryModel::InstalledVersionRole).toString(), u"1.0.0"_s);
        QCOMPARE(at(m, 0, RegistryModel::VersionRole).toString(), u"1.1.0"_s);
        QCOMPARE(at(m, 1, RegistryModel::InstallStateRole).toString(), u"installed"_s);
        QCOMPARE(at(m, 2, RegistryModel::InstallStateRole).toString(), u"available"_s);
        QCOMPARE(at(m, 2, RegistryModel::PermissionsTextRole).toString(), u"Uses the internet · Can't change your files"_s);
        QCOMPARE(at(m, 3, RegistryModel::PermissionsTextRole).toString(), u"Uses the internet · Can change files in ~/Documents/weather"_s);
        QCOMPARE(at(m, 3, RegistryModel::TierLabelRole).toString(), u"Community"_s);
        QVERIFY(at(m, 3, RegistryModel::TierDetailRole).toString().contains(u"asks you before every action"_s));
        QCOMPARE(at(m, 3, RegistryModel::ToolsTextRole).toString(), u"weather.run"_s);
    }

    void dropsEntriesWithBadIdsVersionsOrTiers()
    {
        RegistryModel m;
        m.applyList(QJsonObject{{"installed", QJsonArray{}},
                                {"available", QJsonArray{entry(u"../evil"_s, u"1"_s, u"official"_s),
                                                         entry(u"Install everything; rm -rf"_s, u"1"_s, u"official"_s),
                                                         entry(u"a..b"_s, u"1"_s, u"official"_s),
                                                         entry(u"ok-id"_s, u"1.0 ; rm"_s, u"official"_s),
                                                         entry(u"ok-id"_s, u"1.0"_s, u"trusted"_s)}}});
        QCOMPARE(m.count(), 0);
        QVERIFY(RegistryModel::validId(u"jarvis-files"_s));
        QVERIFY(!RegistryModel::validId(u"Jarvis"_s));
        QVERIFY(RegistryModel::validVersion(u"1.2.3+deb13~1"_s));
    }

    void filterMatchesIdNameAndDescription()
    {
        RegistryModel m;
        QAbstractItemModelTester tester(&m);
        m.applyList(sample());
        m.setFilter(u"WEB"_s);
        QCOMPARE(m.count(), 1);
        QCOMPARE(at(m, 0, RegistryModel::EntryIdRole).toString(), u"jarvis-web"_s);
        m.setFilter(u"does weather"_s);
        QCOMPARE(m.count(), 1);
        m.setFilter(QString());
        QCOMPARE(m.count(), 4);
    }

    void installAndRemoveEmitOnlyWhatTheRowAllows()
    {
        RegistryModel m;
        QSignalSpy installs(&m, &RegistryModel::installRequested);
        QSignalSpy removes(&m, &RegistryModel::removeRequested);
        m.applyList(sample());
        m.install(1); // already installed, same version
        m.remove(2);  // not installed
        QCOMPARE(installs.size(), 0);
        QCOMPARE(removes.size(), 0);
        m.install(2);
        QCOMPARE(installs.last(), (QList<QVariant>{u"jarvis-web"_s, u"1.0.0"_s}));
        m.install(0); // update
        QCOMPARE(installs.last(), (QList<QVariant>{u"jarvis-clock"_s, u"1.1.0"_s}));
        m.remove(1);
        QCOMPARE(removes.last(), (QList<QVariant>{u"old-tool"_s}));
        m.install(42);
        QCOMPARE(installs.size(), 2);
    }

    void refreshAndErrors()
    {
        RegistryModel m;
        QSignalSpy lists(&m, &RegistryModel::listRequested);
        m.refresh();
        QCOMPARE(lists.size(), 1);
        QVERIFY(m.loading());
        m.applyError(u"The registry index signature didn't verify."_s);
        QVERIFY(!m.loading());
        QCOMPARE(m.error(), u"The registry index signature didn't verify."_s);
    }
};

QTEST_GUILESS_MAIN(TestRegistryModel)
#include "tst_registrymodel.moc"
