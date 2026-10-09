#include <QSignalSpy>
#include <QtTest>
#include <optional>

#include "ShellFixture.h"
#include "models/CardModel.h"

using namespace Qt::StringLiterals;

namespace {
void approveACard(ShellFixture& f, const QString& cardId)
{
    f.pushCard(fixture::card(cardId, {fixture::item(u"a"_s)}));
    QTRY_VERIFY(f.shell->chatCard()->active());
    f.shell->decide(f.shell->chatCard(), true);
    f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", cardId}, {"decision", "approved"}});
}
} // namespace

class TestM3Channels : public QObject {
    Q_OBJECT
private slots:
    void undoAfterAnApprovedCard()
    {
        ShellFixture f;
        f.replies.insert(u"agent:undo"_s, {true, QJsonObject{{"undone", "Screen brightness 40% → 70%"}}});
        QVERIFY(f.open());
        QVERIFY(!f.shell->undoAvailable());
        approveACard(f, u"c1"_s);
        QTRY_VERIFY(f.shell->undoAvailable());
        f.shell->undo();
        QTRY_COMPARE(f.lastNotice(), u"Undid: Screen brightness 40% → 70%"_s);
        QVERIFY(f.shell->undoAvailable());
        f.replies.insert(u"agent:undo"_s, {true, QJsonObject{{"undone", QJsonValue::Null}}});
        f.shell->undo();
        QTRY_COMPARE(f.lastNotice(), u"Nothing left to undo."_s);
        QVERIFY(!f.shell->undoAvailable());
        QCOMPARE(f.requests(u"agent:undo"_s).size(), 2);
    }

    void deniedCardsOfferNoUndo()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.shell->decide(f.shell->chatCard(), false);
        f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "denied"}});
        QTRY_COMPARE(f.lastNotice(), u"Denied. Nothing was changed."_s);
        QVERIFY(!f.shell->undoAvailable());
    }

    void undoRefusedWhileLocked()
    {
        ShellFixture f;
        QVERIFY(f.open());
        approveACard(f, u"c1"_s);
        QTRY_VERIFY(f.shell->undoAvailable());
        f.push(u"sys:snapshot"_s, fixture::snapshot(true));
        QTRY_VERIFY(!f.shell->undoAvailable());
        f.shell->undo();
        QTest::qWait(50);
        QVERIFY(f.requests(u"agent:undo"_s).isEmpty());
    }

    void snapshotUndoIsAuthoritative()
    {
        ShellFixture f;
        QVERIFY(f.open());
        QVERIFY(!f.shell->undoAvailable());
        QJsonObject snap = fixture::snapshot(false);
        snap["undo"] = QJsonObject{{"available", true}, {"title", "Screen brightness 40% → 70%"}};
        f.push(u"sys:snapshot"_s, snap); // approved from the phone/CLI: no local card
        QTRY_VERIFY(f.shell->undoAvailable());
        snap["undo"] = QJsonObject{{"available", false}, {"title", QJsonValue::Null}};
        f.push(u"sys:snapshot"_s, snap);
        QTRY_VERIFY(!f.shell->undoAvailable());
        approveACard(f, u"c1"_s); // local inference still works when a snapshot carries no undo
        QTRY_VERIFY(f.shell->undoAvailable());
        f.push(u"sys:snapshot"_s, fixture::snapshot(false));
        QTest::qWait(50);
        QVERIFY(f.shell->undoAvailable());
    }

    void undoErrorIsShown()
    {
        ShellFixture f;
        f.replies.insert(u"agent:undo"_s, {false, {}, u"internal"_s, u"undo stack unavailable"_s});
        QVERIFY(f.open());
        approveACard(f, u"c1"_s);
        QTRY_VERIFY(f.shell->undoAvailable());
        f.shell->undo();
        QTRY_COMPARE(f.lastNotice(), u"Couldn't undo: undo stack unavailable"_s);
    }

    void stopSpeakingAndPairingAnswerAreSent()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.shell->stopSpeaking();
        f.shell->answerPairing(u"r1"_s, false);
        QTRY_COMPARE(f.requests(u"voice:stop"_s).size(), 1);
        QTRY_COMPARE(f.requests(u"pairing:answer"_s).size(), 1);
        const QJsonObject answer = f.requests(u"pairing:answer"_s)[0].value("a").toArray().at(0).toObject();
        QCOMPARE(answer.value("approve").toBool(true), false);
        QCOMPARE(answer.value("requestId").toString(), u"r1"_s);
    }

    void voiceAndPairingPushesAreForwarded()
    {
        ShellFixture f;
        QSignalSpy voice(f.shell.get(), &ShellController::voiceStatePushed);
        QSignalSpy pairing(f.shell.get(), &ShellController::pairingPushed);
        QVERIFY(f.open());
        f.push(u"voice:state"_s, QJsonObject{{"state", "speaking"}, {"lang", "en"}});
        f.push(u"pairing:pending"_s, QJsonObject{{"requestId", "r1"}, {"deviceName", "Pixel"}, {"address", "192.168.1.5"}, {"expiresAt", 1759900000000.0}});
        QTRY_COMPARE(voice.size(), 1);
        QTRY_COMPARE(pairing.size(), 1);
        QCOMPARE(voice[0][0].toJsonObject().value("state").toString(), u"speaking"_s);
        QCOMPARE(pairing[0][0].toJsonObject().value("requestId").toString(), u"r1"_s);
    }

    void sendUtteranceUploads()
    {
        ShellFixture f;
        f.replies.insert(u"voice:utterance"_s, {true, QJsonObject{{"text", "hi"}, {"lang", "en"}, {"action", "prompt"}}});
        QVERIFY(f.open());
        std::optional<ControlResult> got;
        f.shell->sendUtterance(QByteArray(1000, 'w'), QJsonObject{{"lang", "auto"}}, [&](const ControlResult& r) { got = r; });
        QTRY_VERIFY(got.has_value());
        QVERIFY(got->ok);
        QCOMPARE(f.daemon.uploads.size(), 1);
        QCOMPARE(f.daemon.uploads[0].channel, u"voice:utterance"_s);
    }
};

QTEST_GUILESS_MAIN(TestM3Channels)
#include "tst_m3channels.moc"
