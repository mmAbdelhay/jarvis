#include <QSignalSpy>
#include <QtTest>

#include "ShellFixture.h"
#include "models/PhoneModel.h"

using namespace Qt::StringLiterals;

// Settings → Phone (Rafiq M3 contracts §5.9): remote:status (req + push),
// remote:configure, remote:setOwnerPassword, remote:revoke, pairing:open,
// pairing:cancel.
namespace {
QJsonObject status(bool enabled, const QString& pairing = u"closed"_s)
{
    return {{"enabled", enabled},
            {"listening", enabled ? QJsonValue(QJsonObject{{"host", "192.168.1.20"}, {"port", 8765}, {"fingerprint", "ab:cd"}})
                                  : QJsonValue(QJsonValue::Null)},
            {"pairing", pairing},
            {"devices", QJsonArray{QJsonObject{{"id", "dev-1"}, {"name", "Pixel <b>8</b>\nx"}, {"connected", true},
                                               {"lastSeenAt", QJsonValue::Null}}}},
            {"hasOwnerPassword", true},
            {"problem", QJsonValue::Null}};
}

QJsonObject firstArg(const QJsonObject& frame)
{
    return frame.value("a").toArray().at(0).toObject();
}
} // namespace

class TestPhoneSettings : public QObject {
    Q_OBJECT
private slots:
    void statusPushFillsTheModel()
    {
        ShellFixture f;
        QVERIFY(f.open());
        PhoneModel* phone = f.shell->phone();
        QVERIFY(!phone->known());
        f.push(u"remote:status"_s, status(true));
        QTRY_VERIFY(phone->known());
        QVERIFY(phone->enabled());
        QCOMPARE(phone->address(), u"192.168.1.20:8765"_s);
        QCOMPARE(phone->fingerprint(), u"ab:cd"_s);
        QVERIFY(phone->hasOwnerPassword());
        QCOMPARE(phone->devices().size(), 1);
        const QVariantMap device = phone->devices().at(0).toMap();
        QCOMPARE(device.value("id").toString(), u"dev-1"_s);
        QCOMPARE(device.value("name").toString(), u"Pixel <b>8</b> x"_s); // one plain line
        QVERIFY(device.value("connected").toBool());
    }

    void openingSettingsAsksForStatus()
    {
        ShellFixture f;
        f.replies.insert(u"remote:status"_s, {true, status(false)});
        QVERIFY(f.open());
        f.shell->showView(u"settings"_s);
        QTRY_COMPARE(f.requests(u"remote:status"_s).size(), 1);
        QTRY_VERIFY(f.shell->phone()->known());
        QVERIFY(!f.shell->phone()->enabled());
    }

    void turningOnSendsConfigure()
    {
        ShellFixture f;
        f.replies.insert(u"remote:configure"_s, {true, status(true)});
        QVERIFY(f.open());
        f.shell->phone()->setEnabled(true);
        QTRY_COMPARE(f.requests(u"remote:configure"_s).size(), 1);
        QCOMPARE(firstArg(f.requests(u"remote:configure"_s)[0]), (QJsonObject{{"enabled", true}}));
        QTRY_VERIFY(f.shell->phone()->enabled());
    }

    void ownerPasswordSendsCurrentOnlyWhenGiven()
    {
        ShellFixture f;
        f.replies.insert(u"remote:setOwnerPassword"_s, {true, QJsonObject{{"ok", true}}});
        QVERIFY(f.open());
        PhoneModel* phone = f.shell->phone();
        phone->setOwnerPassword(QString(), u"new-secret"_s);
        QTRY_COMPARE(f.requests(u"remote:setOwnerPassword"_s).size(), 1);
        QCOMPARE(firstArg(f.requests(u"remote:setOwnerPassword"_s)[0]), (QJsonObject{{"next", "new-secret"}}));
        QTRY_COMPARE(phone->note(), u"Owner password saved."_s);

        f.replies.insert(u"remote:setOwnerPassword"_s, {true, QJsonObject{{"ok", false}, {"code", "current-wrong"}}});
        phone->setOwnerPassword(u"old"_s, u"newer"_s);
        QTRY_COMPARE(f.requests(u"remote:setOwnerPassword"_s).size(), 2);
        QCOMPARE(firstArg(f.requests(u"remote:setOwnerPassword"_s)[1]),
                 (QJsonObject{{"current", "old"}, {"next", "newer"}}));
        QTRY_COMPARE(phone->error(), u"The current owner password is wrong."_s);
        QVERIFY(!phone->error().contains(u"newer"_s));

        phone->setOwnerPassword(QString(), QString()); // empty: nothing is sent
        QTest::qWait(50);
        QCOMPARE(f.requests(u"remote:setOwnerPassword"_s).size(), 2);
    }

    void pairingOpensAndCancels()
    {
        ShellFixture f;
        f.replies.insert(u"pairing:open"_s, {true, QJsonObject{{"uri", "jarvis://pair?t=abc"}, {"expiresAt", 1}}});
        QVERIFY(f.open());
        PhoneModel* phone = f.shell->phone();
        phone->openPairing();
        QTRY_COMPARE(phone->pairingUri(), u"jarvis://pair?t=abc"_s);
        phone->cancelPairing();
        QTRY_COMPARE(f.requests(u"pairing:cancel"_s).size(), 1);
        QVERIFY(phone->pairingUri().isEmpty());

        phone->openPairing();
        QTRY_VERIFY(!phone->pairingUri().isEmpty());
        f.push(u"remote:status"_s, status(true, u"closed"_s)); // window closed by jarvisd
        QTRY_VERIFY(phone->pairingUri().isEmpty());
    }

    void revokeSendsTheDeviceId()
    {
        ShellFixture f;
        f.replies.insert(u"remote:revoke"_s, {true, QJsonObject{{"revoked", true}}});
        QVERIFY(f.open());
        f.shell->phone()->revoke(u"dev-1"_s);
        QTRY_COMPARE(f.requests(u"remote:revoke"_s).size(), 1);
        QCOMPARE(firstArg(f.requests(u"remote:revoke"_s)[0]), (QJsonObject{{"deviceId", "dev-1"}}));
    }

    void errorsShowTheDaemonText()
    {
        ShellFixture f;
        f.replies.insert(u"pairing:open"_s, {false, QJsonValue::Null, u"unsupported"_s, u"Pairing isn't available."_s});
        QVERIFY(f.open());
        f.shell->phone()->openPairing();
        QTRY_COMPARE(f.shell->phone()->error(), u"Pairing isn't available."_s);
    }
};

QTEST_MAIN(TestPhoneSettings)
#include "tst_phonesettings.moc"
