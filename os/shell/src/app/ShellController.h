#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QtQml/qqmlregistration.h>
#include <functional>

#include "models/AuditModel.h"
#include "models/CardModel.h"
#include "models/Conversation.h"
#include "models/DoctorModel.h"
#include "models/ProviderListModel.h"
#include "models/ProviderModel.h"
#include "models/SystemModel.h"
#include "models/voice/VoiceModel.h"
#include "models/MemoryModel.h"
#include "models/PairingModel.h"
#include "models/RegistryModel.h"

class ControlClient;
struct ControlResult;

// The only place that talks to jarvisd: routes pushes to the models, turns
// model requests into control requests (contracts §3), and owns the view
// state the QML root switches on.
class ShellController : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(bool undoAvailable READ undoAvailable NOTIFY undoChanged)
    Q_PROPERTY(bool undoing READ undoing NOTIFY undoChanged)
    Q_PROPERTY(Conversation* conversation READ conversation CONSTANT)
    Q_PROPERTY(CardModel* chatCard READ chatCard CONSTANT)
    Q_PROPERTY(bool locked READ locked NOTIFY lockedChanged)
    Q_PROPERTY(CardModel* doctorCard READ doctorCard CONSTANT)
    Q_PROPERTY(ProviderModel* provider READ provider CONSTANT)
    Q_PROPERTY(ProviderListModel* providers READ providers CONSTANT)
    Q_PROPERTY(DoctorModel* doctor READ doctor CONSTANT)
    Q_PROPERTY(AuditModel* audit READ audit CONSTANT)
    Q_PROPERTY(SystemModel* system READ system CONSTANT)
    Q_PROPERTY(MemoryModel* memory READ memory CONSTANT)
    Q_PROPERTY(VoiceModel* voice READ voice CONSTANT)
    Q_PROPERTY(PairingModel* pairing READ pairing CONSTANT)
    Q_PROPERTY(RegistryModel* registry READ registry CONSTANT)
    Q_PROPERTY(bool offerDoctor READ offerDoctor NOTIFY providerStatusChanged)
    Q_PROPERTY(QString view READ view NOTIFY viewChanged)
    Q_PROPERTY(QString connection READ connection NOTIFY connectionChanged)
    Q_PROPERTY(bool providerReachable READ providerReachable NOTIFY providerStatusChanged)
    Q_PROPERTY(QString providerError READ providerError NOTIFY providerStatusChanged)
    Q_PROPERTY(QString bannerText READ bannerText NOTIFY bannerChanged)
    Q_PROPERTY(bool updatesChecking READ updatesChecking NOTIFY updatesChanged)
    Q_PROPERTY(QString updatesNote READ updatesNote NOTIFY updatesChanged)

public:
    using Launcher = std::function<bool(const QString& program)>;

    explicit ShellController(ControlClient* client, QObject* parent = nullptr);

    Conversation* conversation() const { return m_conversation; }
    CardModel* chatCard() const { return m_chatCard; }
    bool locked() const { return m_locked; }
    bool undoAvailable() const { return m_undoAvailable && !m_locked; }
    bool undoing() const { return m_undoing; }
    CardModel* doctorCard() const { return m_doctorCard; }
    ProviderModel* provider() const { return m_provider; }
    ProviderListModel* providers() const { return m_providers; }
    DoctorModel* doctor() const { return m_doctor; }
    AuditModel* audit() const { return m_audit; }
    SystemModel* system() const { return m_system; }
    MemoryModel* memory() const { return m_memory; }
    RegistryModel* registry() const { return m_registry; }
    VoiceModel* voice() const { return m_voice; }
    PairingModel* pairing() const { return m_pairing; }
    Q_INVOKABLE void pushToTalk();
    bool handleInstanceMessage(const QByteArray& message);
    Q_INVOKABLE void setSurfaceShown(bool shown) { m_surfaceShown = shown; }
    bool surfaceShown() const { return m_surfaceShown; }
    // Contracts §6.8: only when the provider is unreachable AND the machine is offline.
    bool offerDoctor() const;
    QString view() const { return m_view; }
    QString connection() const { return m_connection; }
    bool providerReachable() const { return m_providerReachable; }
    QString providerError() const { return m_providerError; }
    QString bannerText() const;
    bool updatesChecking() const { return m_updatesChecking; }
    QString updatesNote() const { return m_updatesNote; }

    void setLauncher(Launcher launcher) { m_launcher = std::move(launcher); }

    Q_INVOKABLE bool sendPrompt(const QString& text);
    Q_INVOKABLE void stop();
    Q_INVOKABLE void escape();
    Q_INVOKABLE void decide(CardModel* card, bool approve);
    Q_INVOKABLE void showView(const QString& view);
    Q_INVOKABLE void openDoctor();
    Q_INVOKABLE void openTerminal();
    Q_INVOKABLE void requestComposerFocus();
    Q_INVOKABLE void undo();
    Q_INVOKABLE void stopSpeaking();
    Q_INVOKABLE void answerPairing(const QString& requestId, bool approve);
    // voice:utterance (M3 contracts §2): one 16 kHz mono WAV, header {lang, cardId?}.
    void sendUtterance(const QByteArray& wav, const QJsonObject& header, std::function<void(const ControlResult&)> done);
    Q_INVOKABLE void askForUpdates();
    Q_INVOKABLE void checkForUpdates();

signals:
    void undoChanged();
    void voiceStatePushed(const QJsonObject& state);
    void pairingPushed(const QJsonObject& pending);
    void viewChanged();
    void connectionChanged();
    void providerStatusChanged();
    void bannerChanged();
    void dismissRequested();
    void composerFocusRequested();
    void updatesChanged();
    void lockedChanged();

private:
    void request(const QString& channel, const QJsonArray& args, std::function<void(const ControlResult&)> done = {});
    void onOpened();
    void applyLockState();
    void onClosed();
    void onPush(const QString& channel, const QJsonValue& payload);
    void onAgentEvent(const QJsonObject& event);
    void refreshProviders();
    void askJarvis(const QString& text);
    void maybeLeaveDoctor();
    void setView(QString view);
    void setConnection(const QString& connection);
    void onUtterance(const QByteArray& wav);
    void applyVoiceResult(const QJsonObject& result, const QString& sentCardId);
    CardModel* voiceCard() const;
    void updateVoiceBlock();

    ControlClient* m_client;
    Conversation* m_conversation;
    CardModel* m_chatCard;
    bool m_locked = false;
    bool m_undoAvailable = false;
    bool m_undoing = false;
    CardModel* m_doctorCard;
    ProviderModel* m_provider;
    ProviderListModel* m_providers;
    QString m_fallbackReason;
    DoctorModel* m_doctor;
    AuditModel* m_audit;
    SystemModel* m_system;
    MemoryModel* m_memory;
    RegistryModel* m_registry;
    VoiceModel* m_voice;
    PairingModel* m_pairing;
    bool m_surfaceShown = true;
    QString m_view = QStringLiteral("loading");
    QString m_connection = QStringLiteral("connecting");
    bool m_providerReachable = true;
    QString m_providerError;
    QSet<QString> m_chatCardIds; // chat cards not yet closed, for the single card-closed notice
    Launcher m_launcher;
    bool m_updatesChecking = false;
    QString m_updatesNote;
};
