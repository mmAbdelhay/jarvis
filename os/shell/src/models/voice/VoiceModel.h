#pragma once

#include <QJsonObject>
#include <QObject>
#include <QPointer>
#include <QTimer>
#include <QtQml/qqmlregistration.h>
#include <functional>

#include "models/voice/Recorder.h"

// Push-to-talk (Rafiq M3 design §3.2): one utterance at a time, started by
// Super+Space or the mic button and sent by pressing again or at 60 s. No
// wake word. state: idle | listening | transcribing | speaking — "listening"
// is ours (the mic is open), "transcribing" runs from a sent utterance to its
// reply, the rest is jarvisd's voice:state push. It never talks to jarvisd:
// ShellController uploads utteranceReady() and reports resultArrived().
class VoiceModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by ShellController")
    Q_PROPERTY(bool available READ available NOTIFY changed)
    Q_PROPERTY(QString state READ state NOTIFY changed)
    Q_PROPERTY(QString lang READ lang NOTIFY changed)
    Q_PROPERTY(bool recording READ recording NOTIFY changed)
    Q_PROPERTY(int secondsLeft READ secondsLeft NOTIFY changed)
    Q_PROPERTY(double level READ level NOTIFY levelChanged)
    Q_PROPERTY(QString hint READ hint NOTIFY changed)
    Q_PROPERTY(QString statusText READ statusText NOTIFY changed)
    Q_PROPERTY(bool speakReplies READ speakReplies WRITE setSpeakReplies NOTIFY changed)
    Q_PROPERTY(QString sttName READ sttName NOTIFY changed)
    Q_PROPERTY(QString ttsName READ ttsName NOTIFY changed)

public:
    using RecorderFactory = std::function<jarvis::voice::Recorder*(QObject* parent)>;
    static constexpr int kMaxSeconds = 60;

    explicit VoiceModel(QObject* parent = nullptr);

    void setRecorderFactory(RecorderFactory factory) { m_factory = std::move(factory); }
    void setCountdownIntervalForTest(int ms) { m_countdown.setInterval(ms); }
    static QString settingsPath();

    bool available() const { return m_available; }
    QString state() const;
    QString lang() const { return m_lang; }
    bool recording() const { return !m_recorder.isNull(); }
    int secondsLeft() const { return m_secondsLeft; }
    double level() const { return m_level; }
    QString hint() const { return m_hint; }
    QString statusText() const;
    bool speakReplies() const { return m_speakReplies; }
    void setSpeakReplies(bool on);
    QString sttName() const { return m_stt; }
    QString ttsName() const { return m_tts; }

    Q_INVOKABLE void setAvailability(bool available, const QString& stt, const QString& tts);
    Q_INVOKABLE void applyServerState(const QJsonObject& push);
    void setBlocked(bool blocked, const QString& reason = {});
    Q_INVOKABLE void toggle();
    Q_INVOKABLE bool start();
    Q_INVOKABLE void finish();
    Q_INVOKABLE void cancel();
    void resultArrived();

signals:
    void changed();
    void levelChanged();
    void utteranceReady(const QByteArray& wav);
    void stopSpeakingRequested();
    void speakRepliesChanged(bool on);

private:
    void onFinished(const QByteArray& pcm);
    void onFailed(const QString& message);
    jarvis::voice::Recorder* takeRecorder();
    void setHint(const QString& hint);

    RecorderFactory m_factory;
    QPointer<jarvis::voice::Recorder> m_recorder; // non-null while the mic is open
    QTimer m_countdown;
    bool m_available = false;
    bool m_blocked = false;
    bool m_awaiting = false;
    bool m_speakReplies = true;
    QString m_serverState = QStringLiteral("idle");
    QString m_lang, m_hint, m_stt, m_tts, m_blockedReason;
    int m_secondsLeft = 0;
    double m_level = 0.0;
};
