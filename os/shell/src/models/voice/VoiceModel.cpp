#include "models/voice/VoiceModel.h"

#include "models/voice/WavEncoder.h"

using namespace Qt::StringLiterals;
using jarvis::voice::ProcessRecorder;
using jarvis::voice::Recorder;

VoiceModel::VoiceModel(QObject* parent)
    : QObject(parent)
    , m_factory([](QObject* owner) -> Recorder* { return new ProcessRecorder(ProcessRecorder::defaultCommand(), jarvis::voice::kMaxPcmBytes, owner); })
{
    m_countdown.setInterval(1000);
    connect(&m_countdown, &QTimer::timeout, this, [this] {
        if (--m_secondsLeft <= 0)
            return finish();
        emit changed();
    });
}

QString VoiceModel::state() const
{
    if (recording())
        return u"listening"_s;
    if (m_awaiting)
        return u"transcribing"_s;
    return m_serverState;
}

QString VoiceModel::statusText() const
{
    const QString s = state();
    if (s == u"listening")
        return u"Listening… press Super+Space or the mic again to send (%1 s left)"_s.arg(m_secondsLeft);
    if (s == u"transcribing")
        return u"Working out what you said…"_s;
    if (s == u"speaking")
        return u"Speaking. Press Esc or the mic to stop."_s;
    return {};
}

void VoiceModel::setSpeakReplies(bool on)
{
    if (on == m_speakReplies)
        return;
    m_speakReplies = on;
    emit changed();
    emit speakRepliesChanged(on); // ShellController relays this as voice:setSpeak
}

void VoiceModel::applySnapshotSpeak(bool on)
{
    if (on == m_speakReplies)
        return;
    m_speakReplies = on;
    emit changed(); // jarvisd owns the value: no speakRepliesChanged, so nothing is echoed back
}

void VoiceModel::setAvailability(bool available, const QString& stt, const QString& tts)
{
    if (available == m_available && stt == m_stt && tts == m_tts)
        return;
    m_available = available;
    m_stt = stt;
    m_tts = tts;
    if (!available)
        cancel();
    emit changed();
}

void VoiceModel::applyServerState(const QJsonObject& push)
{
    static const QStringList known{u"idle"_s, u"listening"_s, u"transcribing"_s, u"speaking"_s};
    const QString state = push.value("state").toString();
    m_serverState = known.contains(state) ? state : u"idle"_s;
    const QString lang = push.value("lang").toString();
    m_lang = (lang == u"en" || lang == u"ar") ? lang : QString();
    emit changed();
}

void VoiceModel::setBlocked(bool blocked, const QString& reason)
{
    if (blocked == m_blocked && reason == m_blockedReason)
        return;
    m_blocked = blocked;
    m_blockedReason = reason;
    if (blocked && recording()) {
        cancel();
        m_hint = reason.isEmpty() ? u"Voice is paused."_s : reason;
    }
    emit changed();
}

void VoiceModel::toggle()
{
    if (recording())
        return finish();
    if (state() == u"speaking")
        return emit stopSpeakingRequested();
    start();
}

bool VoiceModel::start()
{
    if (recording() || m_awaiting)
        return false;
    if (!m_available) {
        setHint(u"Voice isn't available on this computer yet."_s);
        return false;
    }
    if (m_blocked) {
        setHint(m_blockedReason.isEmpty() ? u"Voice is paused."_s : m_blockedReason);
        return false;
    }
    Recorder* recorder = m_factory ? m_factory(this) : nullptr;
    if (!recorder) {
        setHint(u"No audio recorder is installed."_s);
        return false;
    }
    connect(recorder, &Recorder::finished, this, &VoiceModel::onFinished);
    connect(recorder, &Recorder::failed, this, &VoiceModel::onFailed);
    connect(recorder, &Recorder::level, this, [this, recorder](double rms) {
        if (recorder != m_recorder)
            return;
        m_level = rms;
        emit levelChanged();
    });
    if (!recorder->start()) {
        setHint(recorder->error());
        recorder->deleteLater();
        return false;
    }
    m_recorder = recorder;
    m_hint.clear();
    m_secondsLeft = kMaxSeconds;
    m_countdown.start();
    emit changed();
    return true;
}

void VoiceModel::finish()
{
    if (!recording())
        return;
    m_countdown.stop();
    m_recorder->stop(); // finished() or failed() follows
}

void VoiceModel::cancel()
{
    if (Recorder* recorder = takeRecorder()) {
        recorder->cancel();
        recorder->deleteLater();
        emit changed();
    }
}

Recorder* VoiceModel::takeRecorder()
{
    m_countdown.stop();
    Recorder* recorder = m_recorder.data();
    m_recorder.clear();
    m_secondsLeft = 0;
    m_level = 0.0;
    emit levelChanged();
    return recorder;
}

void VoiceModel::onFinished(const QByteArray& pcm)
{
    auto* recorder = qobject_cast<Recorder*>(sender());
    if (!recorder || recorder != m_recorder)
        return; // cancelled: whatever it recorded is dropped
    takeRecorder();
    recorder->deleteLater();
    if (m_blocked)
        return emit changed();
    if (pcm.size() < jarvis::voice::kMinPcmBytes) {
        setHint(u"That was too short. Press Super+Space, speak, then press it again."_s);
        return;
    }
    const QByteArray wav = jarvis::voice::wavFromPcm16(pcm);
    if (wav.isEmpty()) {
        setHint(u"That recording was too long to send."_s);
        return;
    }
    m_awaiting = true;
    m_hint.clear();
    emit changed();
    emit utteranceReady(wav);
}

void VoiceModel::onFailed(const QString& message)
{
    auto* recorder = qobject_cast<Recorder*>(sender());
    if (!recorder || recorder != m_recorder)
        return;
    takeRecorder();
    recorder->deleteLater();
    setHint(message.isEmpty() ? u"The microphone stopped."_s : message);
}

void VoiceModel::resultArrived()
{
    if (!m_awaiting)
        return;
    m_awaiting = false;
    emit changed();
}

void VoiceModel::setHint(const QString& hint)
{
    m_hint = hint;
    emit changed();
}
