#include <QSignalSpy>
#include <QTemporaryFile>
#include <QtTest>

#include "FakeInstallerBackend.h"
#include "Fixtures.h"

using namespace Qt::StringLiterals;

class TestFakeBackend : public QObject {
    Q_OBJECT
private slots:
    void probeAnswersAsynchronously()
    {
        FakeInstallerBackend backend;
        backend.probeResult = loadFixture(u"probe-windows.json"_s);
        QSignalSpy probed(&backend, &InstallerBackend::probed);
        backend.probe();
        QCOMPARE(probed.size(), 0); // like D-Bus: never inside the call
        QTRY_COMPARE(probed.size(), 1);
        QCOMPARE(probed.at(0).at(0).toJsonObject().value("uefi").toBool(), true);
        QCOMPARE(backend.calls, QStringList{u"Probe"_s});
    }

    void eachPlanGetsAFreshId()
    {
        FakeInstallerBackend backend;
        backend.planTemplate = loadFixture(u"plan-alongside.json"_s);
        QSignalSpy planned(&backend, &InstallerBackend::planned);
        backend.plan(QJsonObject{{"locale", "en_US.UTF-8"}});
        backend.plan(QJsonObject{{"locale", "ar_EG.UTF-8"}});
        QTRY_COMPARE(planned.size(), 2);
        QCOMPARE(planned.at(0).at(0).toJsonObject().value("planId").toString(), u"fake-plan-1"_s);
        QCOMPARE(planned.at(1).at(0).toJsonObject().value("planId").toString(), u"fake-plan-2"_s);
        QCOMPARE(backend.lastPlanId(), u"fake-plan-2"_s);
        QCOMPARE(backend.choices.at(1).value("locale").toString(), u"ar_EG.UTF-8"_s);
    }

    void refusalIsOneShot()
    {
        FakeInstallerBackend backend;
        backend.refuseKey = u"ntfs-hibernated"_s;
        backend.refuseMessage = u"Windows is hibernated."_s;
        QSignalSpy refused(&backend, &InstallerBackend::refused);
        QSignalSpy planned(&backend, &InstallerBackend::planned);
        backend.plan({});
        QTRY_COMPARE(refused.size(), 1);
        QCOMPARE(refused.at(0).at(0).toString(), u"ntfs-hibernated"_s);
        QCOMPARE(refused.at(0).at(1).toString(), u"Windows is hibernated."_s);
        backend.plan({});
        QTRY_COMPARE(planned.size(), 1);
    }

    void executeOnlyTheLastPlan()
    {
        FakeInstallerBackend backend;
        QSignalSpy accepted(&backend, &InstallerBackend::executeAccepted);
        QSignalSpy failed(&backend, &InstallerBackend::callFailed);
        backend.plan({});
        backend.plan({});
        QTRY_COMPARE(backend.lastPlanId(), u"fake-plan-2"_s);
        backend.execute(u"fake-plan-1"_s, "{}");
        QTRY_COMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"Execute"_s);
        backend.execute(u"fake-plan-2"_s, R"({"userPassword":"pw","luksPassphrase":null})");
        QTRY_COMPARE(accepted.size(), 1);
        QCOMPARE(backend.executedPlanIds, (QStringList{u"fake-plan-1"_s, u"fake-plan-2"_s}));
        QVERIFY(backend.secrets.last() == QByteArray(R"({"userPassword":"pw","luksPassphrase":null})"));
    }

    void failNextFailsOnce()
    {
        FakeInstallerBackend backend;
        backend.failNext = u"Probe"_s;
        QSignalSpy failed(&backend, &InstallerBackend::callFailed);
        QSignalSpy probed(&backend, &InstallerBackend::probed);
        backend.probe();
        QTRY_COMPARE(failed.size(), 1);
        backend.probe();
        QTRY_COMPARE(probed.size(), 1);
    }

    void autoPlayReplaysTheScript()
    {
        QTemporaryFile script;
        QVERIFY(script.open());
        script.write(R"({"probe": {"uefi": true}, "plan": {"summary": ["x"], "steps": []},
                         "intervalMs": 1,
                         "playback": [{"progress": ["partition", 100, ""]}, {"model": [40, "2.1 of 5.2 GB"]},
                                      {"finished": [true, "", ""]}]})");
        script.close();
        FakeInstallerBackend* backend = FakeInstallerBackend::fromFile(script.fileName(), this);
        QVERIFY(backend);
        QSignalSpy progress(backend, &InstallerBackend::progress);
        QSignalSpy model(backend, &InstallerBackend::modelProgress);
        QSignalSpy finished(backend, &InstallerBackend::finished);
        backend->plan({});
        QTRY_VERIFY(!backend->lastPlanId().isEmpty());
        backend->execute(backend->lastPlanId(), "{}");
        QTRY_COMPARE(finished.size(), 1);
        QCOMPARE(progress.at(0).at(0).toString(), u"partition"_s);
        QCOMPARE(model.at(0).at(0).toInt(), 40);
        QVERIFY(finished.at(0).at(0).toBool());
        QVERIFY(!FakeInstallerBackend::fromFile(u"/nonexistent.json"_s, this));
    }
};

QTEST_GUILESS_MAIN(TestFakeBackend)
#include "tst_fakebackend.moc"
