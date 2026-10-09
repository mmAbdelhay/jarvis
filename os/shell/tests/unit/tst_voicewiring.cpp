#include <QPointer>
#include <QStandardPaths>
#include <QtTest>

#include "FakeRecorder.h"
#include "ShellFixture.h"
#include "models/CardModel.h"
#include "models/voice/VoiceModel.h"

using namespace Qt::StringLiterals;

namespace {
struct VoiceRig : ShellFixture {
    QPointer<FakeRecorder> last;
    bool lastCancelled = false;
    VoiceRig()
    {
        shell->voice()->setRecorderFactory([this](QObject* parent) {
            auto* r = new FakeRecorder(parent);
            last = r;
            r->cancelledFlag = &lastCancelled;
            return r;
        });
    }
    bool ready(bool locked = false)
    {
        if (!open())
            return false;
        push(u"sys:snapshot"_s, fixture::snapshot(locked, true));
        return QTest::qWaitFor([this] { return shell->voice()->available(); }, 2000);
    }
    void speak(double seconds = 1.0) // press, talk, press
    {
        shell->pushToTalk();
        QVERIFY(last && last->started);
        shell->pushToTalk();
        last->finish(QByteArray(qsizetype(seconds * 32000), '\x03'));
    }
    QJsonObject header(int n = 0) const { return daemon.uploads.value(n).args.at(0).toObject(); }
    quint64 blobId() const
    {
        for (auto it = daemon.received.crbegin(); it != daemon.received.crend(); ++it)
            if (it->value("t").toString() == u"blob")
                return quint64(it->value("id").toDouble());
        return 0;
    }
    void deferUtterance() { FakeDaemon::Reply r; r.defer = true; replies.insert(u"voice:utterance"_s, r); }
    void answerUtterance(const QString& action, const QString& text = u"yes"_s)
    {
        replies.insert(u"voice:utterance"_s, {true, QJsonObject{{"text", text}, {"lang", "en"}, {"action", action}}});
    }
};
} // namespace

class TestVoiceWiring : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { QStandardPaths::setTestModeEnabled(true); }

    void utteranceUploadsWithoutACard()
    {
        VoiceRig f;
        f.answerUtterance(u"prompt"_s, u"make the screen brighter"_s);
        QVERIFY(f.ready());
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 1);
        QCOMPARE(f.header().value("lang").toString(), u"auto"_s);
        QVERIFY(!f.header().contains("cardId"));
        QCOMPARE(f.daemon.uploads[0].bytes.size(), 32000 + 44);
        QTRY_COMPARE(f.shell->voice()->state(), u"idle"_s);
        QVERIFY(f.requests(u"agent:prompt"_s).isEmpty()); // ruling R1: jarvisd runs the turn
    }

    void cardIdOnlyForAVisibleAnswerableCard()
    {
        VoiceRig f;
        f.answerUtterance(u"ignored"_s, QString());
        QVERIFY(f.ready());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 1);
        QCOMPARE(f.header(0).value("cardId").toString(), u"c1"_s);
        QTRY_COMPARE(f.shell->voice()->state(), u"idle"_s);

        f.shell->setSurfaceShown(false); // dismissed: the card is not on screen
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 2);
        QVERIFY(!f.header(1).contains("cardId"));
        QTRY_COMPARE(f.shell->voice()->state(), u"idle"_s);
        f.shell->setSurfaceShown(true);

        f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "denied"}});
        f.pushCard(fixture::card(u"c2"_s, {fixture::item(u"w"_s, u"net.wifi_connect"_s, u"confirm"_s,
                                           QJsonArray{QJsonObject{{"name", "password"}, {"label", "Wi-Fi password"}}})}));
        QTRY_COMPARE(f.shell->chatCard()->cardId(), u"c2"_s);
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 3);
        QVERIFY(!f.header(2).contains("cardId")); // secrets: never by voice
    }

    void voiceYesApprovesTheTickedItems()
    {
        VoiceRig f;
        f.answerUtterance(u"approve"_s);
        QVERIFY(f.ready());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s), fixture::item(u"b"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.shell->chatCard()->setTicked(1, false);
        f.speak();
        QTRY_COMPARE(f.requests(u"agent:confirm"_s).size(), 1);
        const QJsonObject decision = f.requests(u"agent:confirm"_s)[0].value("a").toArray().at(0).toObject();
        QCOMPARE(decision.value("cardId").toString(), u"c1"_s);
        QVERIFY(decision.value("approve").toBool());
        QCOMPARE(decision.value("ticked").toArray(), (QJsonArray{"a"}));
        QVERIFY(!f.shell->chatCard()->active());
    }

    void voiceNoDenies()
    {
        VoiceRig f;
        f.answerUtterance(u"deny"_s, u"لا"_s);
        QVERIFY(f.ready());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.speak();
        QTRY_COMPARE(f.requests(u"agent:confirm"_s).size(), 1);
        QVERIFY(!f.requests(u"agent:confirm"_s)[0].value("a").toArray().at(0).toObject().value("approve").toBool(true));
    }

    void voiceYesForAClosedCardDoesNothing()
    {
        VoiceRig f;
        f.deferUtterance();
        QVERIFY(f.ready());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 1);
        // Answered on the phone while Whisper was still working.
        f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "approved"}});
        QTRY_VERIFY(!f.shell->chatCard()->active());
        f.daemon.respond(f.blobId(), QJsonObject{{"text", "yes"}, {"lang", "en"}, {"action", "approve"}});
        QTRY_VERIFY(f.lastNotice().contains(u"that card is gone"_s));
        QVERIFY(f.requests(u"agent:confirm"_s).isEmpty());
    }

    void voiceYesForAReplacedCardDoesNothing()
    {
        VoiceRig f;
        f.deferUtterance();
        QVERIFY(f.ready());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 1);
        f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "timeout"}});
        f.pushCard(fixture::card(u"c2"_s, {fixture::item(u"b"_s)}));
        QTRY_COMPARE(f.shell->chatCard()->cardId(), u"c2"_s);
        f.daemon.respond(f.blobId(), QJsonObject{{"text", "yes"}, {"lang", "en"}, {"action", "approve"}});
        QTRY_VERIFY(f.lastNotice().contains(u"that card is gone"_s));
        QVERIFY(f.requests(u"agent:confirm"_s).isEmpty());
        QVERIFY(f.shell->chatCard()->active());
    }

    void lockDiscardsTheRecording()
    {
        VoiceRig f;
        QVERIFY(f.ready());
        f.shell->pushToTalk();
        QVERIFY(f.last && f.last->started);
        f.push(u"sys:snapshot"_s, fixture::snapshot(true, true));
        QTRY_VERIFY(f.lastCancelled); // the model deleteLater()s the recorder, so use the flag
        QTest::qWait(100);
        QVERIFY(f.daemon.uploads.isEmpty());
        f.shell->pushToTalk(); // still locked: refused
        QVERIFY(f.shell->voice()->hint().contains(u"locked"_s));
    }

    void lockBetweenUploadAndAnswerBlocksApproval()
    {
        VoiceRig f;
        f.deferUtterance();
        QVERIFY(f.ready());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.speak();
        QTRY_COMPARE(f.daemon.uploads.size(), 1);
        f.push(u"sys:snapshot"_s, fixture::snapshot(true, true));
        QTRY_VERIFY(f.shell->locked());
        f.daemon.respond(f.blobId(), QJsonObject{{"text", "yes"}, {"lang", "en"}, {"action", "approve"}});
        QTest::qWait(100);
        QVERIFY(f.requests(u"agent:confirm"_s).isEmpty());
        QVERIFY(f.shell->chatCard()->active());
    }

    void speakingIsStoppedWhenRepliesAreOff()
    {
        VoiceRig f;
        QVERIFY(f.ready());
        f.shell->voice()->setSpeakReplies(false);
        f.push(u"voice:state"_s, QJsonObject{{"state", "speaking"}, {"lang", "en"}});
        QTRY_COMPARE(f.requests(u"voice:stop"_s).size(), 1);
        f.shell->voice()->setSpeakReplies(true);
    }

    void escapeCancelsThenStopsSpeech()
    {
        VoiceRig f;
        QVERIFY(f.ready());
        f.shell->pushToTalk();
        QVERIFY(f.shell->voice()->recording());
        f.shell->escape();
        QVERIFY(!f.shell->voice()->recording());
        QVERIFY(f.last->cancelled);
        f.push(u"voice:state"_s, QJsonObject{{"state", "speaking"}});
        QTRY_COMPARE(f.shell->voice()->state(), u"speaking"_s);
        f.shell->escape();
        QTRY_COMPARE(f.requests(u"voice:stop"_s).size(), 1);
    }

    void uploadErrorsAreShown()
    {
        VoiceRig f;
        f.replies.insert(u"voice:utterance"_s, {false, {}, u"unsupported"_s, u"Voice models are not installed"_s});
        QVERIFY(f.ready());
        f.speak();
        QTRY_COMPARE(f.lastNotice(), u"Voice didn't work: Voice models are not installed"_s);
        QCOMPARE(f.shell->voice()->state(), u"idle"_s);
    }
};

QTEST_GUILESS_MAIN(TestVoiceWiring)
#include "tst_voicewiring.moc"
