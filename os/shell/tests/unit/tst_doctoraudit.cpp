#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>

#include "models/AuditModel.h"
#include "models/DoctorModel.h"
#include "models/SystemModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject step(const QString& id, const QString& label, const QString& status, const QString& detail = {})
{
    return {{"stepId", id}, {"label", label}, {"status", status}, {"detail", detail}};
}

QJsonObject entry(double ts, const QString& title, const QString& decision, const QString& result,
                  const QString& message = {}, const QString& via = u"desktop"_s)
{
    QJsonObject out{{"ts", ts}, {"tool", "pkg.install"}, {"title", title}, {"input", QJsonObject{}},
                    {"decision", decision}, {"via", via}, {"result", result}};
    if (!message.isEmpty())
        out.insert("message", message);
    return out;
}
} // namespace

class TestDoctorAudit : public QObject {
    Q_OBJECT
private slots:
    void doctorParsesSteps()
    {
        DoctorModel model;
        QAbstractItemModelTester tester(&model);
        QVERIFY(!model.started());
        model.applyState({{"active", true},
                          {"steps", QJsonArray{step(u"radio"_s, u"Wi-Fi radio is on"_s, u"ok"_s, u"rfkill: not blocked"_s),
                                               step(u"connection"_s, u"No known network nearby"_s, u"problem"_s),
                                               step(u"bogus"_s, u"dropped"_s, u"ok"_s),
                                               step(u"dns"_s, u"DNS answers"_s, u"weird"_s)}},
                          {"networks", QJsonArray{}},
                          {"done", QJsonValue::Null}});
        QVERIFY(model.started());
        QVERIFY(model.active());
        QCOMPARE(model.done(), QString());
        QCOMPARE(model.rowCount(), 3);
        QCOMPARE(model.data(model.index(1), DoctorModel::StatusRole).toString(), u"problem"_s);
        QCOMPARE(model.data(model.index(2), DoctorModel::StatusRole).toString(), u"pending"_s);
        QCOMPARE(model.data(model.index(2), DoctorModel::NumberRole).toInt(), 3);
    }

    void doctorSortsNetworks()
    {
        DoctorModel model;
        model.applyState({{"active", true}, {"steps", QJsonArray{}},
                          {"networks", QJsonArray{QJsonObject{{"ssid", "CoffeeBar"}, {"signal", 20}, {"security", "open"}, {"known", false}},
                                                  QJsonObject{{"ssid", "Home-2.4"}, {"signal", 55}, {"security", "WPA2"}, {"known", true}},
                                                  QJsonObject{{"ssid", "Home-5G"}, {"signal", 80}, {"security", "WPA2"}, {"known", true}}}},
                          {"done", "unfixed"}});
        const QVariantList networks = model.networks();
        QCOMPARE(networks.size(), 3);
        QCOMPARE(networks[0].toMap()["ssid"].toString(), u"Home-5G"_s);
        QCOMPARE(networks[0].toMap()["strength"].toString(), u"strong"_s);
        QCOMPARE(networks[1].toMap()["strength"].toString(), u"good"_s);
        QCOMPARE(networks[2].toMap()["strength"].toString(), u"weak"_s);
        QCOMPARE(model.done(), u"unfixed"_s);
    }

    void doctorAsksForIo()
    {
        DoctorModel model;
        QSignalSpy starts(&model, &DoctorModel::startRequested);
        QSignalSpy skips(&model, &DoctorModel::skipRequested);
        model.start();
        model.skip(u"connection"_s);
        QCOMPARE(starts.size(), 1);
        QCOMPARE(skips[0][0].toString(), u"connection"_s);
        model.applyState({{"active", true}, {"steps", QJsonArray{step(u"nm"_s, u"x"_s, u"ok"_s)}}});
        model.reset();
        QVERIFY(!model.started());
        QCOMPARE(model.rowCount(), 0);
    }

    void auditLabels()
    {
        AuditModel model;
        QAbstractItemModelTester tester(&model);
        model.applyEntries({entry(3000, u"Install VLC 3.0.21 from Debian"_s, u"approved"_s, u"ok"_s),
                            entry(2000, u"Install steam from Debian"_s, u"approved"_s, u"failed"_s, u"needs i386 enabled"_s),
                            entry(1500, u"Remove GIMP"_s, u"denied"_s, u"skipped"_s),
                            entry(1000, u"Restart docker"_s, u"timeout"_s, u"skipped"_s, {}, u"doctor"_s),
                            entry(500, u"bad"_s, u"maybe"_s, u"ok"_s)},
                           false);
        QCOMPARE(model.rowCount(), 4); // the malformed decision is dropped
        QCOMPARE(model.data(model.index(0), AuditModel::ResultLabelRole).toString(), u"Done"_s);
        QCOMPARE(model.data(model.index(1), AuditModel::ResultLabelRole).toString(), u"Failed: needs i386 enabled"_s);
        QVERIFY(model.data(model.index(1), AuditModel::FailedRole).toBool());
        QCOMPARE(model.data(model.index(2), AuditModel::DecisionLabelRole).toString(), u"Denied"_s);
        QCOMPARE(model.data(model.index(2), AuditModel::ResultLabelRole).toString(), u"Nothing changed"_s);
        QCOMPARE(model.data(model.index(3), AuditModel::DecisionLabelRole).toString(), u"Timed out"_s);
        QCOMPARE(model.data(model.index(3), AuditModel::ViaRole).toString(), u"Doctor"_s);
    }

    void auditFilters()
    {
        AuditModel model;
        model.applyEntries({entry(3, u"a"_s, u"approved"_s, u"ok"_s), entry(2, u"b"_s, u"approved"_s, u"failed"_s),
                            entry(1, u"c"_s, u"denied"_s, u"skipped"_s), entry(0, u"d"_s, u"timeout"_s, u"skipped"_s)},
                           false);
        model.setFilter(u"approved"_s);
        QCOMPARE(model.rowCount(), 2);
        model.setFilter(u"denied"_s);
        QCOMPARE(model.rowCount(), 2);
        model.setFilter(u"failed"_s);
        QCOMPARE(model.rowCount(), 1);
        QCOMPARE(model.data(model.index(0), AuditModel::TitleRole).toString(), u"b"_s);
        model.setFilter(u"nonsense"_s);
        QCOMPARE(model.filter(), u"failed"_s);
        model.setFilter(u"all"_s);
        QCOMPARE(model.rowCount(), 4);
    }

    void auditPaging()
    {
        AuditModel model;
        QSignalSpy requests(&model, &AuditModel::listRequested);
        model.refresh();
        QVERIFY(model.loading());
        QCOMPARE(requests[0][0].toInt(), 200);
        QCOMPARE(requests[0][1].toDouble(), 0.0);
        QJsonArray page;
        for (int i = 0; i < AuditModel::kPageSize; ++i)
            page.append(entry(10000 - i, "t" + QString::number(i), u"approved"_s, u"ok"_s));
        model.applyEntries(page, false);
        QVERIFY(!model.loading());
        QVERIFY(model.hasMore());
        model.loadMore();
        QCOMPARE(requests[1][1].toDouble(), double(10000 - AuditModel::kPageSize + 1));
        model.applyEntries({entry(1, u"older"_s, u"denied"_s, u"skipped"_s)}, true);
        QCOMPARE(model.rowCount(), AuditModel::kPageSize + 1);
        QVERIFY(!model.hasMore());
        model.loadMore();
        QCOMPARE(requests.size(), 2);
    }

    void auditRecent()
    {
        AuditModel model;
        model.applyEntries({entry(4, u"Installed VLC"_s, u"approved"_s, u"ok"_s), entry(3, u"remove GIMP"_s, u"denied"_s, u"skipped"_s),
                            entry(2, u"restart docker"_s, u"timeout"_s, u"skipped"_s), entry(1, u"older"_s, u"approved"_s, u"ok"_s)},
                           false);
        model.setFilter(u"failed"_s);
        const QVariantList recent = model.recent();
        QCOMPARE(recent.size(), 3);
        QCOMPARE(recent[0].toMap()["text"].toString(), u"Installed VLC"_s);
        QCOMPARE(recent[1].toMap()["text"].toString(), u"Denied: remove GIMP"_s);
        QCOMPARE(recent[2].toMap()["text"].toString(), u"Timed out: restart docker"_s);
    }

    void dropsEntriesWithoutANumericTimestamp()
    {
        // contracts §6.23: on the control socket ts is epoch ms (RFC 3339 is only for MCP results).
        AuditModel model;
        QJsonObject good = entry(1760000000000.0, u"good"_s, u"approved"_s, u"ok"_s);
        QJsonObject text = entry(0, u"string ts"_s, u"approved"_s, u"ok"_s);
        text["ts"] = u"2026-10-07T13:20:00Z"_s;
        QJsonObject negative = entry(-5, u"negative"_s, u"approved"_s, u"ok"_s);
        QJsonObject missing = entry(0, u"missing"_s, u"approved"_s, u"ok"_s);
        missing.remove("ts");
        model.applyEntries({good, text, negative, missing}, false);
        QCOMPARE(model.rowCount(), 1);
        QCOMPARE(model.data(model.index(0), AuditModel::TsRole).toDouble(), 1760000000000.0);
    }

    void systemSnapshot()
    {
        SystemModel model;
        QVERIFY(!model.known());
        QSignalSpy changed(&model, &SystemModel::changed);
        const double gib = 1024.0 * 1024 * 1024;
        model.applySnapshot({{"online", true},
                             {"network", QJsonObject{{"connectivity", "full"}, {"wifiSsid", "Home-5G"}}},
                             {"memTotalBytes", 16 * gib}, {"memUsedBytes", 3.1 * gib},
                             {"disk", QJsonObject{{"mount", "/"}, {"sizeBytes", 186 * gib}, {"usedBytes", 71 * gib}}},
                             {"failedUnits", QJsonArray{"NetworkManager.service"}},
                             {"model", QJsonObject{{"kind", "ollama"}, {"model", "qwen3:8b"}, {"local", true}, {"supportsTools", true}}}});
        QCOMPARE(changed.size(), 1);
        QVERIFY(model.known());
        QVERIFY(model.online());
        QCOMPARE(model.networkText(), u"Online"_s);
        QCOMPARE(model.networkDetail(), u"Wi-Fi Home-5G · online"_s);
        QCOMPARE(model.memoryText(), u"3.1 / 16 GB"_s);
        QCOMPARE(model.diskText(), u"71 / 186 GB"_s);
        QVERIFY(qAbs(model.diskFraction() - 71.0 / 186.0) < 1e-6);
        QCOMPARE(model.failedUnits(), QStringList{u"NetworkManager.service"_s});
        QVERIFY(model.hasModel());
        QCOMPARE(model.modelName(), u"qwen3:8b"_s);
        QCOMPARE(model.modelDetail(), u"On your machines · can control the OS"_s);

        model.applySnapshot({{"online", false},
                             {"network", QJsonObject{{"connectivity", "none"}, {"wifiSsid", QJsonValue::Null}}},
                             {"memTotalBytes", 0}, {"memUsedBytes", 0},
                             {"disk", QJsonObject{}}, {"failedUnits", QJsonArray{}},
                             {"model", QJsonValue::Null}});
        QVERIFY(!model.online());
        QCOMPARE(model.networkText(), u"Offline"_s);
        QCOMPARE(model.networkDetail(), u"connectivity: no internet"_s);
        QCOMPARE(model.memoryFraction(), 0.0);
        QVERIFY(!model.hasModel());
        model.reset();
        QVERIFY(!model.known());
    }

    void formatsGigabytes()
    {
        QCOMPARE(SystemModel::formatGb(0), u"0.0"_s);
        QCOMPARE(SystemModel::formatGb(3.14 * 1024 * 1024 * 1024), u"3.1"_s);
        QCOMPARE(SystemModel::formatGb(185.6 * 1024 * 1024 * 1024), u"186"_s);
    }

    void formatsTimes()
    {
        const QDateTime now(QDate(2026, 10, 7), QTime(14, 7));
        QCOMPARE(AuditModel::formatTime(QDateTime(QDate(2026, 10, 7), QTime(13, 20)).toMSecsSinceEpoch(), now), u"13:20"_s);
        QCOMPARE(AuditModel::formatTime(QDateTime(QDate(2026, 10, 5), QTime(9, 5)).toMSecsSinceEpoch(), now), u"5 Oct 09:05"_s);
    }
};

QTEST_GUILESS_MAIN(TestDoctorAudit)
#include "tst_doctoraudit.moc"
