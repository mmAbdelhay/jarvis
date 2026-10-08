#pragma once

#include <QObject>
#include <QProcess>
#include <QStringList>

#include "models/voice/WavEncoder.h"

namespace jarvis::voice {

// Captures mono s16le 16 kHz PCM. After a successful start(), exactly one of
// finished()/failed() follows — unless cancel() comes first (then neither).
class Recorder : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    virtual bool start() = 0; // false: nothing was started; error() says why
    virtual void stop() = 0;
    virtual void cancel() = 0;
    virtual QString error() const = 0;

signals:
    void level(double rms);
    void finished(const QByteArray& pcm);
    void failed(const QString& message);
};

// Runs a capture program that writes raw PCM to stdout (pacat, else
// pw-record). The audio lives only in memory; it never touches the disk.
class ProcessRecorder : public Recorder {
    Q_OBJECT
public:
    explicit ProcessRecorder(QStringList command = defaultCommand(), qsizetype maxBytes = kMaxPcmBytes,
                             QObject* parent = nullptr);
    ~ProcessRecorder() override;

    static QStringList defaultCommand();

    bool start() override;
    void stop() override;
    void cancel() override;
    QString error() const override { return m_error; }

private:
    enum class Phase { Idle, Recording, Stopping, Cancelled };
    void onReadyRead();
    void onFinished();

    QStringList m_command;
    qsizetype m_maxBytes;
    QProcess m_process;
    QByteArray m_pcm;
    QString m_error;
    Phase m_phase = Phase::Idle;
};

} // namespace jarvis::voice
