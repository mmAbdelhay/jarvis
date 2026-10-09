#include <QDBusConnection>
#include <QDBusContext>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QtTest>
#include <utility>

#include "DBusInstallerBackend.h"

using namespace Qt::StringLiterals;

// Stands in for Plan F's jarvis-installer-backend on a private session bus.
class FakeInstallerService : public QObject, protected QDBusContext {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "os.jarvis.Installer1")
public:
    QString probeJson = uR"({"uefi":true,"disks":[]})"_s;
    QString planJson = uR"({"planId":"p-1","summary":["Erase the disk"],"steps":[],"diskAfter":[],"warnings":[]})"_s;
    QString refuse;    // full Refused message, e.g. "ntfs-dirty: Volume is dirty"
    QString errorName; // any other D-Bus error for the next call
    QStringList calls;
    QString lastChoices, lastPlanId, lastSecrets;

public slots:
    QString Probe()
    {
        calls << u"Probe"_s;
        return fail() ? QString() : probeJson;
    }
    QString Plan(const QString& choices)
    {
        calls << u"Plan"_s;
        lastChoices = choices;
        if (!refuse.isEmpty()) {
            sendErrorReply(u"os.jarvis.Installer1.Error.Refused"_s, std::exchange(refuse, QString()));
            return {};
        }
        return fail() ? QString() : planJson;
    }
    void Execute(const QString& planId, const QString& secretsJson)
    {
        calls << u"Execute"_s;
        lastPlanId = planId;
        lastSecrets = secretsJson;
        fail();
    }
    void Cancel() { calls << u"Cancel"_s; }

signals:
    void Progress(const QString& stepId, int percent, const QString& detail);
    void ModelProgress(int percent, const QString& detail);
    void Finished(bool ok, const QString& errorStep, const QString& message);

private:
    bool fail()
    {
        if (errorName.isEmpty())
            return false;
        sendErrorReply(std::exchange(errorName, QString()), u"Backend broke"_s);
        return true;
    }
};

class TestDBusBackend : public QObject {
    Q_OBJECT
    FakeInstallerService m_service;
    QDBusConnection m_bus{QDBusConnection::connectToBus(QDBusConnection::SessionBus, u"fake-installer"_s)};

private slots:
    void initTestCase()
    {
        QVERIFY2(m_bus.isConnected(), "run under dbus-run-session");
        QVERIFY(m_bus.registerService(u"os.jarvis.Installer1"_s));
        QVERIFY(m_bus.registerObject(u"/os/jarvis/Installer1"_s, &m_service,
                                     QDBusConnection::ExportAllSlots | QDBusConnection::ExportAllSignals));
    }
    void init() { m_service.calls.clear(); }

    void probeReturnsTheParsedResult()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy probed(&backend, &InstallerBackend::probed);
        backend.probe();
        QTRY_COMPARE(probed.size(), 1);
        QVERIFY(probed.at(0).at(0).toJsonObject().value("uefi").toBool());
    }

    void planSendsCompactJsonAndAnswersPlanned()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy planned(&backend, &InstallerBackend::planned);
        backend.plan(QJsonObject{{"locale", "en_US.UTF-8"}, {"encrypt", true}});
        QTRY_COMPARE(planned.size(), 1);
        QCOMPARE(QJsonDocument::fromJson(m_service.lastChoices.toUtf8()).object(),
                 (QJsonObject{{"locale", "en_US.UTF-8"}, {"encrypt", true}}));
        QVERIFY(!m_service.lastChoices.contains(u'\n'));
        QCOMPARE(planned.at(0).at(0).toJsonObject().value("planId").toString(), u"p-1"_s);
    }

    void refusedIsSplitIntoKeyAndWords()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy refused(&backend, &InstallerBackend::refused);
        m_service.refuse = u"ntfs-dirty: Volume is dirty"_s;
        backend.plan({});
        QTRY_COMPARE(refused.size(), 1);
        QCOMPARE(refused.at(0).at(0).toString(), u"ntfs-dirty"_s);
        QCOMPARE(refused.at(0).at(1).toString(), u"Volume is dirty"_s);
    }

    void otherErrorsAreCallFailures()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy failed(&backend, &InstallerBackend::callFailed);
        m_service.errorName = u"org.freedesktop.DBus.Error.AccessDenied"_s;
        backend.plan({});
        QTRY_COMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"Plan"_s);
        QCOMPARE(failed.at(0).at(1).toString(), u"Backend broke"_s);
    }

    void unreadableAnswerIsACallFailure()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy failed(&backend, &InstallerBackend::callFailed);
        m_service.probeJson = u"not json"_s;
        backend.probe();
        QTRY_COMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"Probe"_s);
        m_service.probeJson = uR"({"uefi":true,"disks":[]})"_s;
    }

    void executePassesPlanIdAndSecrets()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy accepted(&backend, &InstallerBackend::executeAccepted);
        backend.execute(u"p-1"_s, R"({"userPassword":"pw","luksPassphrase":null})");
        QTRY_COMPARE(accepted.size(), 1);
        QCOMPARE(m_service.lastPlanId, u"p-1"_s);
        const bool secretsMatch = m_service.lastSecrets == uR"({"userPassword":"pw","luksPassphrase":null})"_s;
        m_service.lastSecrets.fill(QChar(u'\0'));
        QVERIFY(secretsMatch);
        backend.cancel();
        QTRY_VERIFY(m_service.calls.contains(u"Cancel"_s));
    }

    void signalsAreForwarded()
    {
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy progress(&backend, &InstallerBackend::progress);
        QSignalSpy model(&backend, &InstallerBackend::modelProgress);
        QSignalSpy finished(&backend, &InstallerBackend::finished);
        QTest::qWait(50); // let the match rules reach the bus
        emit m_service.Progress(u"copy"_s, 62, u"Copying system files"_s);
        emit m_service.ModelProgress(37, u"1.9 of 5.2 GB"_s);
        emit m_service.Finished(false, u"copy"_s, u"write error"_s);
        QTRY_COMPARE(finished.size(), 1);
        QCOMPARE(progress.at(0), (QList<QVariant>{u"copy"_s, 62, u"Copying system files"_s}));
        QCOMPARE(model.at(0), (QList<QVariant>{37, u"1.9 of 5.2 GB"_s}));
        QCOMPARE(finished.at(0), (QList<QVariant>{false, u"copy"_s, u"write error"_s}));
    }

    void serviceMissingIsAPlainError()
    {
        QVERIFY(m_bus.unregisterService(u"os.jarvis.Installer1"_s));
        DBusInstallerBackend backend(QDBusConnection::sessionBus());
        QSignalSpy failed(&backend, &InstallerBackend::callFailed);
        backend.probe();
        QTRY_COMPARE(failed.size(), 1);
        QVERIFY(!failed.at(0).at(1).toString().isEmpty());
        QVERIFY(m_bus.registerService(u"os.jarvis.Installer1"_s));
    }
};

QTEST_GUILESS_MAIN(TestDBusBackend)
#include "tst_dbusbackend.moc"
