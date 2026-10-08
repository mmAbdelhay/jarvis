#include <QFile>
#include <QPointer>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QtTest>

#include "FakeRecorder.h"
#include "models/voice/VoiceModel.h"

using namespace Qt::StringLiterals;

namespace {
struct Rig {
    VoiceModel voice;
    QPointer<FakeRecorder> last;
    bool startOk = true;
    Rig()
    {
        voice.setRecorderFactory([this](QObject* parent) {
            auto* r = new FakeRecorder(parent);
            r->startOk = startOk;
            last = r;
            return r;
        });
        voice.setAvailability(true, u"whisper base"_s, u"en_US-amy-medium"_s);
    }
};
QByteArray seconds(double s) { return QByteArray(qsizetype(s * 32000) & ~qsizetype(1), '\x02'); }
} // namespace

class TestVoiceModel : public QObject {
    Q_OBJECT
private slots:
    void initTestCase()
    {
        QStandardPaths::setTestModeEnabled(true);
        QFile::remove(VoiceModel::settingsPath());
    }

    void unavailableRefusesToStart()
    {
        VoiceModel voice;
        QVERIFY(!voice.start());
        QVERIFY(voice.hint().contains(u"isn't available"_s));
        QCOMPARE(voice.state(), u"idle"_s);
    }

    void toggleRecordsAndSends()
    {
        Rig rig;
        QSignalSpy ready(&rig.voice, &VoiceModel::utteranceReady);
        rig.voice.toggle();
        QVERIFY(rig.voice.recording());
        QCOMPARE(rig.voice.state(), u"listening"_s);
        QCOMPARE(rig.voice.secondsLeft(), VoiceModel::kMaxSeconds);
        QVERIFY(rig.voice.statusText().contains(u"Listening"_s));
        rig.voice.toggle();
        QVERIFY(rig.last->stopped);
        rig.last->finish(seconds(1));
        QCOMPARE(ready.size(), 1);
        QCOMPARE(ready[0][0].toByteArray().size(), 32000 + 44);
        QCOMPARE(rig.voice.state(), u"transcribing"_s);
        QVERIFY(!rig.voice.start()); // one utterance at a time
        rig.voice.resultArrived();
        QCOMPARE(rig.voice.state(), u"idle"_s);
    }

    void tooShortIsDropped()
    {
        Rig rig;
        QSignalSpy ready(&rig.voice, &VoiceModel::utteranceReady);
        QVERIFY(rig.voice.start());
        rig.voice.finish();
        rig.last->finish(seconds(0.2));
        QCOMPARE(ready.size(), 0);
        QVERIFY(rig.voice.hint().contains(u"too short"_s));
        QCOMPARE(rig.voice.state(), u"idle"_s);
    }

    void countdownSendsAtTheCap()
    {
        Rig rig;
        rig.voice.setCountdownIntervalForTest(5);
        QVERIFY(rig.voice.start());
        QTRY_VERIFY(rig.last->stopped);
    }

    void blockedCancelsAndDiscards()
    {
        Rig rig;
        QSignalSpy ready(&rig.voice, &VoiceModel::utteranceReady);
        QVERIFY(rig.voice.start());
        QPointer<FakeRecorder> recorder = rig.last;
        rig.voice.setBlocked(true, u"Voice is off while the screen is locked."_s);
        QVERIFY(recorder->cancelled);
        QVERIFY(!rig.voice.recording());
        QCOMPARE(rig.voice.hint(), u"Voice is off while the screen is locked."_s);
        if (recorder)
            recorder->finish(seconds(2)); // a late delivery is ignored
        QCOMPARE(ready.size(), 0);
        QVERIFY(!rig.voice.start());
        rig.voice.setBlocked(false);
        QVERIFY(rig.voice.start());
    }

    void recorderFailuresShowTheirReason()
    {
        Rig rig;
        rig.startOk = false;
        QVERIFY(!rig.voice.start());
        QCOMPARE(rig.voice.hint(), u"No microphone"_s);
        rig.startOk = true;
        QVERIFY(rig.voice.start());
        rig.last->fail(u"Device busy"_s);
        QCOMPARE(rig.voice.hint(), u"Device busy"_s);
        QVERIFY(!rig.voice.recording());
    }

    void serverStates()
    {
        Rig rig;
        QSignalSpy stop(&rig.voice, &VoiceModel::stopSpeakingRequested);
        rig.voice.applyServerState({{"state", "speaking"}, {"lang", "ar"}});
        QCOMPARE(rig.voice.state(), u"speaking"_s);
        QCOMPARE(rig.voice.lang(), u"ar"_s);
        rig.voice.toggle(); // the mic while Jarvis speaks = stop speaking
        QCOMPARE(stop.size(), 1);
        QVERIFY(!rig.voice.recording());
        rig.voice.applyServerState({{"state", "<script>"}, {"lang", "xx"}});
        QCOMPARE(rig.voice.state(), u"idle"_s);
        QCOMPARE(rig.voice.lang(), QString());
    }

    void losingAvailabilityCancels()
    {
        Rig rig;
        QVERIFY(rig.voice.start());
        rig.voice.setAvailability(false, {}, {});
        QVERIFY(rig.last->cancelled);
        QVERIFY(!rig.voice.available());
    }

    void localStatesOverrideServerUntilResult()
    {
        Rig rig;
        QVERIFY(rig.voice.start());
        rig.voice.applyServerState({{"state", "speaking"}, {"lang", "en"}});
        QCOMPARE(rig.voice.state(), u"listening"_s);
        rig.voice.finish();
        rig.last->finish(seconds(1));
        QCOMPARE(rig.voice.state(), u"transcribing"_s);
        rig.voice.resultArrived();
        QCOMPARE(rig.voice.state(), u"speaking"_s);
    }

    void cancelledRecorderCannotUpdateNextRecording()
    {
        Rig rig;
        QSignalSpy ready(&rig.voice, &VoiceModel::utteranceReady);
        QVERIFY(rig.voice.start());
        QPointer<FakeRecorder> old = rig.last;
        emit old->level(0.5);
        QCOMPARE(rig.voice.level(), 0.5);
        rig.voice.cancel();
        QCOMPARE(rig.voice.level(), 0.0);
        QVERIFY(rig.voice.start());
        emit old->level(0.9);
        old->fail(u"Stale error"_s);
        old->finish(seconds(1));
        QCOMPARE(rig.voice.level(), 0.0);
        QVERIFY(rig.voice.hint().isEmpty());
        QVERIFY(rig.voice.recording());
        QCOMPARE(ready.size(), 0);
    }

    void oversizedRecordingIsDropped()
    {
        Rig rig;
        QSignalSpy ready(&rig.voice, &VoiceModel::utteranceReady);
        QVERIFY(rig.voice.start());
        rig.voice.finish();
        rig.last->finish(QByteArray(4194304, '\x02'));
        QCOMPARE(ready.size(), 0);
        QCOMPARE(rig.voice.state(), u"idle"_s);
        QVERIFY(rig.voice.hint().contains(u"too long"_s));
    }

    void speakRepliesPersists()
    {
        {
            VoiceModel voice;
            QVERIFY(voice.speakReplies());
            QSignalSpy spy(&voice, &VoiceModel::speakRepliesChanged);
            voice.setSpeakReplies(false);
            QCOMPARE(spy.size(), 1);
        }
        VoiceModel again;
        QVERIFY(!again.speakReplies());
        again.setSpeakReplies(true);
    }
};

QTEST_GUILESS_MAIN(TestVoiceModel)
#include "tst_voicemodel.moc"
