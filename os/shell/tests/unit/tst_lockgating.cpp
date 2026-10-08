#include <QtTest>

#include "ShellFixture.h"
#include "models/CardModel.h"
#include "models/SystemModel.h"

using namespace Qt::StringLiterals;

class TestLockGating : public QObject {
    Q_OBJECT
private slots:
    void snapshotCarriesLockAndVoice()
    {
        SystemModel system;
        system.applySnapshot(fixture::snapshot(true, true));
        QVERIFY(system.locked());
        QVERIFY(system.voiceAvailable());
        QCOMPARE(system.voiceStt(), u"whisper base"_s);
        QCOMPARE(system.voiceTts(), u"en_US-amy-medium"_s);
        QJsonObject snap = fixture::snapshot(false);
        snap.insert("voice", QJsonObject{{"available", true}, {"stt", true}, {"tts", false}});
        system.applySnapshot(snap);
        QVERIFY(!system.locked());
        QCOMPARE(system.voiceStt(), u"ready"_s);
        QCOMPARE(system.voiceTts(), QString());
        QJsonObject m2 = fixture::snapshot(false);
        m2.remove("locked");
        m2.remove("voice");
        system.applySnapshot(m2); // an M2.5 daemon: unlocked, no voice
        QVERIFY(!system.locked());
        QVERIFY(!system.voiceAvailable());
    }

    void voiceAnswerableRules()
    {
        CardModel card;
        card.setClockForTest(1000);
        const auto load = [&](const QJsonArray& items) {
            card.close();
            return card.load({{"cardId", "c1"}, {"turnId", "t1"}, {"expiresAt", 301000.0}, {"items", items}});
        };
        QVERIFY(load({fixture::item(u"a"_s)}));
        QVERIFY(card.voiceAnswerable());
        QVERIFY(load({fixture::item(u"a"_s), fixture::item(u"b"_s, u"users.add"_s, u"password"_s)}));
        QVERIFY(!card.voiceAnswerable());
        QVERIFY(load({fixture::item(u"w"_s, u"net.wifi_connect"_s, u"confirm"_s,
                                    QJsonArray{QJsonObject{{"name", "password"}, {"label", "Wi-Fi password"}}})}));
        QVERIFY(!card.voiceAnswerable());
        QVERIFY(load({fixture::item(u"a"_s)}));
        card.setLocked(true);
        QVERIFY(!card.voiceAnswerable());
        QVERIFY(!card.canApprove());
        card.setLocked(false);
        card.setClockForTest(302000);
        card.tick();
        QVERIFY(!card.voiceAnswerable()); // expired
        QVERIFY(card.source().value("cardId").toString() == u"c1"_s);
    }

    void cardsFollowTheLockState()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"sys:snapshot"_s, fixture::snapshot(true));
        QTRY_VERIFY(f.shell->locked());
        QVERIFY(f.shell->chatCard()->locked());
        QVERIFY(f.shell->doctorCard()->locked());
        f.push(u"sys:snapshot"_s, fixture::snapshot(false));
        QTRY_VERIFY(!f.shell->locked());
        QVERIFY(!f.shell->chatCard()->locked());
    }

    void approveRefusedWhileLocked()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.push(u"sys:snapshot"_s, fixture::snapshot(true));
        QTRY_VERIFY(f.shell->locked());
        f.shell->decide(f.shell->chatCard(), true);
        f.shell->decide(f.shell->chatCard(), false);
        QTest::qWait(100);
        QVERIFY(f.requests(u"agent:confirm"_s).isEmpty());
        QVERIFY(f.shell->chatCard()->active());
        QCOMPARE(f.lastNotice(), u"The screen is locked. Unlock it to answer this card."_s);
    }

    void lockedErrorReopensTheCard()
    {
        ShellFixture f;
        f.replies.insert(u"agent:confirm"_s, {false, {}, u"locked"_s, u"The session is locked"_s});
        QVERIFY(f.open());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.shell->decide(f.shell->chatCard(), true); // jarvisd locked before our snapshot arrived
        QVERIFY(!f.shell->chatCard()->active());
        QTRY_VERIFY(f.shell->chatCard()->active());
        QCOMPARE(f.shell->chatCard()->cardId(), u"c1"_s);
        QCOMPARE(f.lastNotice(), u"The screen is locked. Unlock it to answer this card."_s);
    }
};

QTEST_GUILESS_MAIN(TestLockGating)
#include "tst_lockgating.moc"
