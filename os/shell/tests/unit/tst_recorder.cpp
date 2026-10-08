#include <QSignalSpy>
#include <QTemporaryFile>
#include <QtEndian>
#include <QtTest>

#include "models/voice/Recorder.h"
#include "models/voice/WavEncoder.h"

using namespace Qt::StringLiterals;
using namespace jarvis::voice;

namespace {
QString pcmFile(QTemporaryFile& file, const QByteArray& pcm)
{
    file.open();
    file.write(pcm);
    file.flush();
    return file.fileName();
}
QString fakeRecorder() { return QFINDTESTDATA("../data/fake-recorder.sh"); }
} // namespace

class TestRecorder : public QObject {
    Q_OBJECT
private slots:
    void wavHeaderIsCanonical()
    {
        const QByteArray wav = wavFromPcm16(QByteArray(32000, '\x01'));
        QCOMPARE(wav.size(), 32044);
        QCOMPARE(wav.left(4), QByteArray("RIFF"));
        QCOMPARE(qFromLittleEndian<quint32>(wav.constData() + 4), quint32(32036));
        QCOMPARE(wav.mid(8, 8), QByteArray("WAVEfmt "));
        QCOMPARE(qFromLittleEndian<quint32>(wav.constData() + 16), quint32(16));
        QCOMPARE(qFromLittleEndian<quint16>(wav.constData() + 20), quint16(1));     // PCM
        QCOMPARE(qFromLittleEndian<quint16>(wav.constData() + 22), quint16(1));     // mono
        QCOMPARE(qFromLittleEndian<quint32>(wav.constData() + 24), quint32(16000)); // rate
        QCOMPARE(qFromLittleEndian<quint32>(wav.constData() + 28), quint32(32000)); // byte rate
        QCOMPARE(qFromLittleEndian<quint16>(wav.constData() + 32), quint16(2));     // block align
        QCOMPARE(qFromLittleEndian<quint16>(wav.constData() + 34), quint16(16));    // bits
        QCOMPARE(wav.mid(36, 4), QByteArray("data"));
        QCOMPARE(qFromLittleEndian<quint32>(wav.constData() + 40), quint32(32000));
    }

    void wavLimits()
    {
        QVERIFY(wavFromPcm16({}).isEmpty());
        QCOMPARE(wavFromPcm16(QByteArray(3, 'x')).size(), 46); // odd byte dropped
        QCOMPARE(wavFromPcm16(QByteArray(kMaxWavBytes - kWavHeaderBytes, 'x')).size(), kMaxWavBytes);
        QVERIFY(wavFromPcm16(QByteArray(kMaxWavBytes - kWavHeaderBytes + 2, 'x')).isEmpty());
        QVERIFY(kMaxPcmBytes + kWavHeaderBytes <= kMaxWavBytes); // 60 s always fits in 4 MiB
    }

    void rmsLevels()
    {
        QCOMPARE(rmsLevel(QByteArray(3200, '\0')), 0.0);
        QByteArray loud;
        for (int i = 0; i < 1600; ++i) {
            char sample[2];
            qToLittleEndian<qint16>(i % 2 ? qint16(32767) : qint16(-32768), sample);
            loud.append(sample, 2);
        }
        QVERIFY(rmsLevel(loud) > 0.99);
    }

    void collectsPcmUntilStopped()
    {
        const QByteArray pcm(6400, '\x05');
        QTemporaryFile file;
        ProcessRecorder recorder({u"sh"_s, fakeRecorder(), pcmFile(file, pcm)});
        QSignalSpy finished(&recorder, &Recorder::finished);
        QSignalSpy level(&recorder, &Recorder::level);
        QVERIFY(recorder.start());
        QTRY_VERIFY(!level.isEmpty());
        recorder.stop();
        QTRY_COMPARE(finished.size(), 1);
        QCOMPARE(finished[0][0].toByteArray(), pcm);
    }

    void cancelEmitsNothing()
    {
        QTemporaryFile file;
        ProcessRecorder recorder({u"sh"_s, fakeRecorder(), pcmFile(file, QByteArray(6400, '\x05'))});
        QSignalSpy finished(&recorder, &Recorder::finished);
        QSignalSpy failed(&recorder, &Recorder::failed);
        QVERIFY(recorder.start());
        QTest::qWait(100);
        recorder.cancel();
        QTest::qWait(300);
        QCOMPARE(finished.size(), 0);
        QCOMPARE(failed.size(), 0);
    }

    void cancelThenImmediateStartIsRejected()
    {
        const QByteArray pcm(6400, '\x05');
        QTemporaryFile file;
        ProcessRecorder recorder({u"sh"_s, fakeRecorder(), pcmFile(file, pcm)});
        QSignalSpy finished(&recorder, &Recorder::finished);
        QSignalSpy failed(&recorder, &Recorder::failed);
        QSignalSpy level(&recorder, &Recorder::level);
        QVERIFY(recorder.start());
        QTRY_VERIFY(!level.isEmpty());
        recorder.cancel();
        // No event processing between cancel and start: the old process
        // has not delivered its finished signal yet.
        QVERIFY(!recorder.start());
        QTest::qWait(300);
        QCOMPARE(finished.size(), 0);
        QCOMPARE(failed.size(), 0);

        level.clear();
        QVERIFY(recorder.start());
        QTRY_VERIFY(!level.isEmpty());
        recorder.stop();
        QTRY_COMPARE(finished.size(), 1);
        QCOMPARE(finished[0][0].toByteArray(), pcm);
        QCOMPARE(failed.size(), 0);
    }

    void capStopsTheRecording()
    {
        QTemporaryFile file;
        ProcessRecorder recorder({u"sh"_s, fakeRecorder(), pcmFile(file, QByteArray(5000, '\x05'))}, 1000);
        QSignalSpy finished(&recorder, &Recorder::finished);
        QVERIFY(recorder.start());
        QTRY_COMPARE(finished.size(), 1); // no stop() call: the cap ends it
        QCOMPARE(finished[0][0].toByteArray().size(), 1000);
    }

    void programThatExitsByItselfStillDelivers()
    {
        QTemporaryFile file;
        ProcessRecorder recorder({u"cat"_s, pcmFile(file, QByteArray(4801, '\x05'))});
        QSignalSpy finished(&recorder, &Recorder::finished);
        QVERIFY(recorder.start());
        QTRY_COMPARE(finished.size(), 1);
        QCOMPARE(finished[0][0].toByteArray().size(), 4800); // odd trailing byte dropped
    }

    void silentExitFails()
    {
        ProcessRecorder recorder({u"true"_s});
        QSignalSpy failed(&recorder, &Recorder::failed);
        QVERIFY(recorder.start());
        QTRY_COMPARE(failed.size(), 1);
    }

    void missingProgramOrCommandFails()
    {
        ProcessRecorder missing({u"/nonexistent/recorder"_s});
        QVERIFY(!missing.start());
        QVERIFY(!missing.error().isEmpty());
        ProcessRecorder none(QStringList{});
        QVERIFY(!none.start());
        QVERIFY(none.error().contains(u"pacat"_s));
    }

    void environmentOverridesTheCommand()
    {
        qputenv("JARVIS_SHELL_RECORD_COMMAND", "sh /tmp/x.sh --raw");
        QCOMPARE(ProcessRecorder::defaultCommand(), (QStringList{u"sh"_s, u"/tmp/x.sh"_s, u"--raw"_s}));
        qunsetenv("JARVIS_SHELL_RECORD_COMMAND");
    }
};

QTEST_GUILESS_MAIN(TestRecorder)
#include "tst_recorder.moc"
