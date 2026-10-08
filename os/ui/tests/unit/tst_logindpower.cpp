#include <QDBusConnection>
#include <QDBusContext>
#include <QDBusError>
#include <QSignalSpy>
#include <QtTest>

#include "LogindPower.h"

using namespace Qt::StringLiterals;

// Stands in for systemd-logind on the private session bus of the test.
class FakeLogind : public QObject, protected QDBusContext {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.freedesktop.login1.Manager")
public:
    QStringList calls;
    bool deny = false;
public slots:
    void PowerOff(bool interactive) { record(u"PowerOff"_s, interactive); }
    void Reboot(bool interactive) { record(u"Reboot"_s, interactive); }

private:
    void record(const QString& name, bool interactive)
    {
        calls.append(name + (interactive ? u":true"_s : u":false"_s));
        if (deny)
            sendErrorReply(QDBusError::AccessDenied, u"Not allowed"_s);
    }
};

class TestLogindPower : public QObject {
    Q_OBJECT
    FakeLogind m_fake;
    QDBusConnection m_service{QDBusConnection::connectToBus(QDBusConnection::SessionBus, u"fake-logind"_s)};

private slots:
    void initTestCase()
    {
        QVERIFY2(m_service.isConnected(), "run under dbus-run-session");
        QVERIFY(m_service.registerService(u"org.freedesktop.login1"_s));
        QVERIFY(m_service.registerObject(u"/org/freedesktop/login1"_s, &m_fake, QDBusConnection::ExportAllSlots));
    }
    void init()
    {
        m_fake.calls.clear();
        m_fake.deny = false;
    }

    void rebootAndPowerOffAreNonInteractive()
    {
        LogindPower power(QDBusConnection::sessionBus());
        QVERIFY(power.available());
        power.reboot();
        QTRY_COMPARE(m_fake.calls, QStringList{u"Reboot:false"_s});
        power.powerOff();
        QTRY_COMPARE(m_fake.calls, (QStringList{u"Reboot:false"_s, u"PowerOff:false"_s}));
    }

    void refusalIsReported()
    {
        m_fake.deny = true;
        LogindPower power(QDBusConnection::sessionBus());
        QSignalSpy failed(&power, &PowerActions::failed);
        power.powerOff();
        QTRY_COMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"Not allowed"_s);
    }

    void missingLogindIsReported()
    {
        QVERIFY(m_service.unregisterService(u"org.freedesktop.login1"_s));
        LogindPower power(QDBusConnection::sessionBus());
        QSignalSpy failed(&power, &PowerActions::failed);
        power.reboot();
        QTRY_COMPARE(failed.size(), 1);
        QVERIFY(!failed.at(0).at(0).toString().isEmpty());
        QVERIFY(m_service.registerService(u"org.freedesktop.login1"_s));
    }
};

QTEST_GUILESS_MAIN(TestLogindPower)
#include "tst_logindpower.moc"
