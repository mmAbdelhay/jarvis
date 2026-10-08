#pragma once

#include "models/voice/Recorder.h"

// A Recorder the test drives. No Q_OBJECT: it adds no signals or slots and
// emits the base class's, so it needs no moc.
class FakeRecorder : public jarvis::voice::Recorder {
public:
    using Recorder::Recorder;
    bool startOk = true;
    bool started = false;
    bool stopped = false;
    bool cancelled = false;
    QString startError = QStringLiteral("No microphone");

    bool start() override { started = startOk; return startOk; }
    void stop() override { stopped = true; }
    void cancel() override { cancelled = true; }
    QString error() const override { return startError; }
    void finish(const QByteArray& pcm) { emit finished(pcm); }
    void fail(const QString& message) { emit failed(message); }
};
