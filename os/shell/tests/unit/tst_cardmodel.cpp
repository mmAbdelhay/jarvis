#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QtTest>

#include "models/CardModel.h"

using namespace Qt::StringLiterals;

namespace {
constexpr double kNow = 1'000'000;

QJsonObject item(const QString& id, const QString& tool, const QString& title, const QString& source,
                 const QJsonArray& secretFields = {})
{
    return {{"itemId", id}, {"tool", tool}, {"title", title}, {"detail", "detail " + id},
            {"source", source}, {"risk", "confirm"}, {"secretFields", secretFields}};
}

QJsonObject card(const QJsonArray& items, const QJsonValue& turnId = u"t1"_s)
{
    return {{"cardId", "c1"}, {"turnId", turnId}, {"expiresAt", kNow + 300000}, {"items", items}};
}

QJsonArray installs()
{
    return {item(u"vlc"_s, u"pkg.install"_s, u"Install VLC 3.0.21"_s, u"debian"_s),
            item(u"gimp"_s, u"pkg.install"_s, u"Install GIMP 3.0.4"_s, u"debian"_s),
            item(u"spotify"_s, u"pkg.install"_s, u"Install Spotify"_s, u"flathub"_s)};
}

QJsonArray wifi(const QStringList& ids)
{
    QJsonArray out;
    for (const QString& id : ids)
        out.append(item(id, u"net.wifi_connect"_s, "Connect to " + id, u"network"_s,
                        QJsonArray{QJsonObject{{"name", "password"}, {"label", "Wi-Fi password"}}}));
    return out;
}
} // namespace

class TestCardModel : public QObject {
    Q_OBJECT
private slots:
    void rejectsMalformedCards()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(!model.load({{"turnId", "t1"}, {"expiresAt", kNow}, {"items", installs()}}));
        QVERIFY(!model.load(card({})));
        QVERIFY(!model.load({{"cardId", "c1"}, {"items", installs()}}));
        QJsonArray duplicate = installs();
        duplicate.append(item(u"vlc"_s, u"pkg.install"_s, u"again"_s, u"debian"_s));
        QVERIFY(!model.load(card(duplicate)));
        QVERIFY(!model.active());
    }

    void everyItemIsTickedByDefault()
    {
        CardModel model;
        QAbstractItemModelTester tester(&model);
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(installs())));
        QVERIFY(model.active());
        QCOMPARE(model.itemCount(), 3);
        QCOMPARE(model.tickedCount(), 3);
        QCOMPARE(model.headline(), u"Jarvis wants to do 3 things"_s);
        QCOMPARE(model.approveLabel(), u"Approve all 3"_s);
        QCOMPARE(model.data(model.index(2), CardModel::SourceLabelRole).toString(), u"Flathub"_s);
        QCOMPARE(model.turnId(), u"t1"_s);
    }

    void untickingOneApprovesTheRest()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(installs())));
        model.toggle(1);
        QCOMPARE(model.tickedCount(), 2);
        QCOMPARE(model.approveLabel(), u"Approve 2 of 3"_s);
        const QJsonObject decision = model.decision(true);
        QCOMPARE(decision["cardId"].toString(), u"c1"_s);
        QCOMPARE(decision["approve"].toBool(), true);
        QCOMPARE(decision["ticked"].toArray(), (QJsonArray{"vlc", "spotify"}));
        QCOMPARE(decision["secrets"].toObject(), QJsonObject());
    }

    void denySendsNothing()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(wifi({u"home"_s}))));
        model.setSecret(0, u"password"_s, u"hunter2"_s);
        const QJsonObject decision = model.decision(false);
        QCOMPARE(decision["approve"].toBool(), false);
        QCOMPARE(decision["ticked"].toArray(), QJsonArray());
        QCOMPARE(decision["secrets"].toObject(), QJsonObject());
    }

    void secretsGoOnlyWithTickedItems()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QJsonArray items = wifi({u"home"_s});
        items.append(item(u"nm"_s, u"svc.restart"_s, u"Restart NetworkManager"_s, u"system"_s));
        QVERIFY(model.load(card(items)));
        QVERIFY(!model.exclusive()); // mixed tools: ordinary batch
        model.setSecret(0, u"password"_s, u"hunter2"_s);
        model.setSecret(0, u"notDeclared"_s, u"x"_s);
        QCOMPARE(model.decision(true)["secrets"].toObject(),
                 (QJsonObject{{"home", QJsonObject{{"password", "hunter2"}}}}));
        model.setTicked(0, false);
        QCOMPARE(model.decision(true)["secrets"].toObject(), QJsonObject());
        QCOMPARE(model.decision(true)["ticked"].toArray(), QJsonArray{"nm"});
    }

    void untickingClearsThatItemsSecrets()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QJsonArray items = wifi({u"home"_s});
        items.append(item(u"nm"_s, u"svc.restart"_s, u"Restart NetworkManager"_s, u"system"_s));
        QVERIFY(model.load(card(items)));
        model.setSecret(0, u"password"_s, u"stale-pass"_s);
        model.setTicked(0, false);
        model.setTicked(0, true); // re-ticking must not resend the old password
        QCOMPARE(model.decision(true)["ticked"].toArray(), (QJsonArray{"home", "nm"}));
        QCOMPARE(model.decision(true)["secrets"].toObject(), QJsonObject());
        model.toggle(0);
        model.toggle(0);
        QCOMPARE(model.decision(true)["secrets"].toObject(), QJsonObject());
    }

    void pickingAnotherNetworkClearsTheFirstPassword()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(wifi({u"a"_s, u"b"_s}), QJsonValue::Null)));
        model.setTicked(0, true);
        model.setSecret(0, u"password"_s, u"pass-a"_s);
        model.setTicked(1, true); // exclusive: unticks a
        model.setTicked(0, true); // back to a
        QCOMPARE(model.decision(true)["ticked"].toArray(), QJsonArray{"a"});
        QCOMPARE(model.decision(true)["secrets"].toObject(), QJsonObject());
    }

    void nothingTickedCannotApprove()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(installs())));
        for (int row = 0; row < 3; ++row)
            model.setTicked(row, false);
        QVERIFY(!model.canApprove());
        QCOMPARE(model.decision(true)["approve"].toBool(), false);
        QCOMPARE(model.decision(true)["ticked"].toArray(), QJsonArray());
    }

    void countdownAndExpiry()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(installs())));
        QCOMPARE(model.countdownText(), u"Auto-deny in 5:00"_s);
        model.setClockForTest(kNow + 8000);
        QCOMPARE(model.secondsLeft(), 292);
        QCOMPARE(model.countdownText(), u"Auto-deny in 4:52"_s);
        model.setClockForTest(kNow + 299500);
        QCOMPARE(model.countdownText(), u"Auto-deny in 0:01"_s);
        model.setClockForTest(kNow + 300000);
        QVERIFY(model.expired());
        QVERIFY(!model.canApprove());
        QCOMPARE(model.countdownText(), u"Timed out"_s);
        QCOMPARE(model.decision(true)["approve"].toBool(), false);
    }

    void wifiNetworksArePickOne()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(wifi({u"a"_s, u"b"_s}), QJsonValue::Null)));
        QVERIFY(model.exclusive());
        QCOMPARE(model.turnId(), QString());
        QCOMPARE(model.tickedCount(), 0);
        QCOMPARE(model.approveLabel(), u"Connect"_s);
        QVERIFY(!model.canApprove());
        model.setTicked(0, true);
        model.setTicked(1, true);
        QCOMPARE(model.tickedCount(), 1);
        QCOMPARE(model.decision(true)["ticked"].toArray(), QJsonArray{"b"});
    }

    void aSingleNetworkIsStillPickOne()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(wifi({u"home"_s}), QJsonValue::Null)));
        QVERIFY(model.exclusive());
        QCOMPARE(model.tickedCount(), 0);
        QVERIFY(!model.canApprove());
        model.setTicked(0, true);
        model.setSecret(0, u"password"_s, u"pa55word"_s);
        QCOMPARE(model.decision(true)["secrets"].toObject(),
                 (QJsonObject{{"home", QJsonObject{{"password", "pa55word"}}}}));
    }

    void reloadingTheSameCardKeepsTicks()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(installs())));
        model.setTicked(1, false);
        QVERIFY(model.load(card(installs()))); // jarvisd re-pushes open cards on reconnect (§6.7)
        QCOMPARE(model.tickedCount(), 2);
        QVERIFY(!model.data(model.index(1), CardModel::TickedRole).toBool());
    }

    void singleItemWording()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card({item(u"nm"_s, u"svc.restart"_s, u"Restart NetworkManager"_s, u"system"_s)})));
        QCOMPARE(model.headline(), u"Jarvis needs your approval"_s);
        QCOMPARE(model.approveLabel(), u"Approve"_s);
    }

    void closeClearsEverything()
    {
        CardModel model;
        model.setClockForTest(kNow);
        QVERIFY(model.load(card(wifi({u"home"_s}))));
        model.setSecret(0, u"password"_s, u"hunter2"_s);
        model.close();
        QVERIFY(!model.active());
        QCOMPARE(model.rowCount(), 0);
        QCOMPARE(model.cardId(), QString());
        QCOMPARE(model.decision(true)["secrets"].toObject(), QJsonObject());
    }
};

QTEST_GUILESS_MAIN(TestCardModel)
#include "tst_cardmodel.moc"
