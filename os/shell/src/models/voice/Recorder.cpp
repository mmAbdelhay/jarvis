#include "models/voice/Recorder.h"

#include <QStandardPaths>
#include <QTimer>
#include <algorithm>
#include <utility>

using namespace Qt::StringLiterals;

namespace jarvis::voice {

ProcessRecorder::ProcessRecorder(QStringList command, qsizetype maxBytes, QObject* parent)
    : Recorder(parent)
    , m_command(std::move(command))
    , m_maxBytes(maxBytes)
{
    m_process.setProcessChannelMode(QProcess::SeparateChannels);
    m_process.setStandardErrorFile(QProcess::nullDevice());
    connect(&m_process, &QProcess::readyReadStandardOutput, this, &ProcessRecorder::onReadyRead);
    connect(&m_process, &QProcess::finished, this, &ProcessRecorder::onFinished);
}

ProcessRecorder::~ProcessRecorder()
{
    m_phase = Phase::Cancelled;
    if (m_process.state() != QProcess::NotRunning) {
        m_process.kill();
        m_process.waitForFinished(500);
    }
    m_pcm.fill('\0');
}

QStringList ProcessRecorder::defaultCommand()
{
    const QString override = qEnvironmentVariable("JARVIS_SHELL_RECORD_COMMAND");
    if (!override.isEmpty())
        return QProcess::splitCommand(override);
    if (!QStandardPaths::findExecutable(u"pacat"_s).isEmpty())
        return {u"pacat"_s, u"--record"_s, u"--raw"_s, u"--rate=16000"_s, u"--channels=1"_s,
                u"--format=s16le"_s, u"--latency-msec=50"_s, u"--client-name=Jarvis"_s};
    if (!QStandardPaths::findExecutable(u"pw-record"_s).isEmpty())
        return {u"pw-record"_s, u"--rate"_s, u"16000"_s, u"--channels"_s, u"1"_s, u"--format"_s, u"s16"_s, u"-"_s};
    return {};
}

bool ProcessRecorder::start()
{
    if (m_phase == Phase::Recording || m_phase == Phase::Stopping)
        return false;
    if (m_command.isEmpty()) {
        m_error = u"No audio recorder is installed (pacat or pw-record)."_s;
        return false;
    }
    m_pcm.clear();
    m_error.clear();
    m_process.setProgram(m_command.first());
    m_process.setArguments(m_command.mid(1));
    m_process.start(QIODevice::ReadOnly);
    if (!m_process.waitForStarted(2000)) {
        m_error = u"The microphone recorder could not start."_s;
        m_phase = Phase::Idle;
        return false;
    }
    m_phase = Phase::Recording;
    return true;
}

void ProcessRecorder::stop()
{
    if (m_phase != Phase::Recording)
        return;
    m_phase = Phase::Stopping;
    m_process.terminate();
    QTimer::singleShot(1000, this, [this] {
        if (m_process.state() != QProcess::NotRunning)
            m_process.kill();
    });
}

void ProcessRecorder::cancel()
{
    if (m_phase != Phase::Recording && m_phase != Phase::Stopping)
        return;
    m_phase = Phase::Cancelled;
    m_pcm.fill('\0');
    m_pcm.clear();
    m_process.kill();
}

void ProcessRecorder::onReadyRead()
{
    const QByteArray chunk = m_process.readAllStandardOutput();
    if (m_phase != Phase::Recording && m_phase != Phase::Stopping)
        return;
    m_pcm += chunk.left(std::max<qsizetype>(0, m_maxBytes - m_pcm.size()));
    emit level(rmsLevel(chunk.right(3200)));
    if (m_phase == Phase::Recording && m_pcm.size() >= m_maxBytes)
        stop();
}

void ProcessRecorder::onFinished()
{
    const Phase phase = std::exchange(m_phase, Phase::Idle);
    if (phase == Phase::Cancelled || phase == Phase::Idle)
        return;
    // Whatever the program wrote after the last readyRead (the phase is Idle
    // now, so onReadyRead would drop it).
    m_pcm += m_process.readAllStandardOutput().left(std::max<qsizetype>(0, m_maxBytes - m_pcm.size()));
    if (m_pcm.size() % 2)
        m_pcm.chop(1);
    QByteArray pcm = std::exchange(m_pcm, {});
    if (pcm.isEmpty()) {
        emit failed(u"The microphone recorder stopped without any audio."_s);
        return;
    }
    emit finished(pcm);
}

} // namespace jarvis::voice
