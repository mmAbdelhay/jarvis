#include "app/ShellController.h"

#include "Language.h"
#include <initializer_list>
#include <QPointer>
#include <QProcess>

#include "control/ControlClient.h"

using namespace Qt::StringLiterals;

namespace {
constexpr int kMaxPromptLength = 8000; // contracts §3.1 agent:prompt

// Rafiq v1.1 contracts §2: the session card has an item with tool "cu.begin".
bool isComputerUseCard(const QJsonObject& card)
{
    for (const QJsonValue& item : card.value("items").toArray())
        if (item.toObject().value("tool").toString() == u"cu.begin")
            return true;
    return false;
}
}

ShellController::ShellController(ControlClient* client, QObject* parent)
    : QObject(parent)
    , m_client(client)
    , m_conversation(new Conversation(this))
    , m_chatCard(new CardModel(this))
    , m_doctorCard(new CardModel(this))
    , m_accounts(new AccountsModel(this))
    , m_provider(new ProviderModel(this))
    , m_providers(new ProviderListModel(this))
    , m_doctor(new DoctorModel(this))
    , m_audit(new AuditModel(this))
    , m_system(new SystemModel(this))
    , m_memory(new MemoryModel(this))
    , m_registry(new RegistryModel(this))
    , m_voice(new VoiceModel(this))
    , m_pairing(new PairingModel(this))
    , m_phone(new PhoneModel(this))
    , m_cu(new CuSessionModel(this))
    , m_cuSettings(new CuSettingsModel(this))
    , m_launcher([](const QString& program) { return QProcess::startDetached(program, {}); })
    , m_daemonDownTimer(new QTimer(this))
{
    // Contracts §6.14: jarvisd unreachable this long -> offer classic mode.
    m_daemonDownTimer->setSingleShot(true);
    m_daemonDownTimer->setInterval(15000);
    connect(m_daemonDownTimer, &QTimer::timeout, this, [this] { setDaemonDown(true); });
    m_daemonDownTimer->start(); // not connected yet
    connect(client, &ControlClient::opened, this, &ShellController::onOpened);
    connect(client, &ControlClient::closed, this, &ShellController::onClosed);
    connect(client, &ControlClient::push, this, &ShellController::onPush);

    connect(m_provider, &ProviderModel::probeRequested, this, [this](const QJsonObject& draft) {
        request(u"provider:probe"_s, QJsonArray{draft}, [this](const ControlResult& r) {
            if (r.ok)
                m_provider->applyProbeResult(r.value.toObject());
            else
                m_provider->applyRequestError(r.text);
        });
    });
    connect(m_provider, &ProviderModel::saveRequested, this, [this](const QJsonObject& draft) {
        QString id = m_provider->editingId();
        if (id.isEmpty())
            id = m_providers->uniqueId(m_provider->suggestedId());
        QJsonObject withId = draft;
        withId.insert("id", id);
        request(u"provider:save"_s, QJsonArray{m_providers->payloadWith(withId)}, [this, id](const ControlResult& r) {
            if (r.ok)
                m_provider->applySaveResult(ProviderListModel::resultFor(r.value.toObject(), id));
            else
                m_provider->applyRequestError(r.text);
        });
    });
    connect(m_provider, &ProviderModel::saved, this, [this] {
        if (m_view != u"settings")
            setView(u"chat"_s);
        refreshProviders();
    });
    connect(m_providers, &ProviderListModel::saveRequested, this, [this](const QJsonObject& payload) {
        request(u"provider:save"_s, QJsonArray{payload}, [this](const ControlResult& r) {
            if (r.ok)
                m_providers->applySaveResult(r.value.toObject());
            else
                m_providers->applyRequestError(r.text);
        });
    });
    connect(m_providers, &ProviderListModel::saved, this, &ShellController::refreshProviders);
    connect(m_provider, &ProviderModel::activeChanged, this, &ShellController::bannerChanged);
    connect(m_system, &SystemModel::changed, this, &ShellController::providerStatusChanged);
    connect(m_system, &SystemModel::changed, this, &ShellController::applyLockState);

    connect(m_doctor, &DoctorModel::startRequested, this, [this] {
        request(u"doctor:start"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (r.ok)
                m_doctor->applyState(r.value.toObject());
            else
                m_conversation->addNotice(tr("Network doctor couldn't start: %1").arg(r.text));
        });
    });
    connect(m_doctor, &DoctorModel::skipRequested, this, [this](const QString& stepId) {
        request(u"doctor:skip"_s, QJsonArray{QJsonObject{{"stepId", stepId}}}, [this](const ControlResult& r) {
            if (r.ok)
                m_doctor->applyState(r.value.toObject());
        });
    });
    connect(m_audit, &AuditModel::listRequested, this, [this](int limit, double beforeTs) {
        QJsonObject query{{"limit", limit}};
        if (beforeTs > 0)
            query.insert("beforeTs", beforeTs);
        const bool append = beforeTs > 0;
        request(u"audit:list"_s, QJsonArray{query}, [this, append](const ControlResult& r) {
            if (r.ok)
                m_audit->applyEntries(r.value.toArray(), append);
            else
                m_audit->applyError(r.text);
        });
    });
    connect(m_memory, &MemoryModel::listRequested, this, [this](int limit) {
        request(u"memory:list"_s, QJsonArray{QJsonObject{{"limit", limit}}}, [this](const ControlResult& r) {
            if (r.ok)
                m_memory->applyItems(r.value.toArray());
            else
                m_memory->applyError(r.text);
        });
    });
    connect(m_memory, &MemoryModel::deleteRequested, this, [this](const QString& id) {
        request(u"memory:delete"_s, QJsonArray{QJsonObject{{"id", id}}}, [this, id](const ControlResult& r) {
            if (r.ok)
                m_memory->applyDeleted(id);
            else
                m_memory->applyError(r.text);
        });
    });
    connect(m_memory, &MemoryModel::clearRequested, this, [this] {
        request(u"memory:clear"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (r.ok)
                m_memory->applyCleared();
            else
                m_memory->applyError(r.text);
        });
    });
    connect(m_registry, &RegistryModel::listRequested, this, [this] {
        request(u"registry:list"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (r.ok)
                m_registry->applyList(r.value.toObject());
            else
                m_registry->applyError(r.text);
        });
    });
    // Contracts §2: install/remove happen through tools and cards, never a channel.
    connect(m_registry, &RegistryModel::installRequested, this, [this](const QString& id, const QString& version) {
        askJarvis(tr("Install the tool server %1 version %2 from the Jarvis tool registry.").arg(id, version));
    });
    connect(m_registry, &RegistryModel::removeRequested, this, [this](const QString& id) {
        askJarvis(tr("Remove the installed tool server %1.").arg(id));
    });
    // Settings → Phone (M3 contracts §5.9).
    const auto phoneStatus = [this](const ControlResult& r) {
        if (r.ok)
            m_phone->applyStatus(r.value.toObject());
        else
            m_phone->applyError(r.text);
    };
    connect(m_phone, &PhoneModel::statusRequested, this, [this, phoneStatus] {
        request(u"remote:status"_s, QJsonArray{}, phoneStatus);
    });
    connect(m_phone, &PhoneModel::configureRequested, this, [this, phoneStatus](bool enabled) {
        request(u"remote:configure"_s, QJsonArray{QJsonObject{{"enabled", enabled}}}, phoneStatus);
    });
    connect(m_phone, &PhoneModel::ownerPasswordRequested, this, [this](const QString& current, const QString& next) {
        QJsonObject args{{"next", next}};
        if (!current.isEmpty())
            args.insert("current", current);
        request(u"remote:setOwnerPassword"_s, QJsonArray{args}, [this](const ControlResult& r) {
            if (r.ok)
                m_phone->applyOwnerPasswordResult(r.value.toObject());
            else
                m_phone->applyError(r.text);
        });
    });
    connect(m_phone, &PhoneModel::pairingOpenRequested, this, [this] {
        request(u"pairing:open"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (r.ok)
                m_phone->applyPairingOpened(r.value.toObject());
            else
                m_phone->applyError(r.text);
        });
    });
    connect(m_phone, &PhoneModel::pairingCancelRequested, this, [this] {
        request(u"pairing:cancel"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (!r.ok)
                m_phone->applyError(r.text);
        });
    });
    connect(m_phone, &PhoneModel::revokeRequested, this, [this](const QString& deviceId) {
        request(u"remote:revoke"_s, QJsonArray{QJsonObject{{"deviceId", deviceId}}}, [this](const ControlResult& r) {
            if (r.ok)
                m_phone->refresh();
            else
                m_phone->applyError(r.text);
        });
    });
    connect(m_memory, &MemoryModel::setEnabledRequested, this, [this](bool enabled) {
        request(u"memory:setEnabled"_s, QJsonArray{QJsonObject{{"enabled", enabled}}}, [this](const ControlResult& r) {
            if (r.ok)
                m_memory->refresh();
            else
                m_memory->applyError(r.text);
        });
    });
    connect(m_voice, &VoiceModel::utteranceReady, this, &ShellController::onUtterance);
    connect(m_voice, &VoiceModel::stopSpeakingRequested, this, &ShellController::stopSpeaking);
    connect(m_voice, &VoiceModel::speakRepliesChanged, this, [this](bool on) {
        // M3 contracts §5 #10: jarvisd owns the setting; voice:setSpeak [{on}].
        request(u"voice:setSpeak"_s, QJsonArray{QJsonObject{{"on", on}}});
        if (!on && m_voice->state() == u"speaking")
            stopSpeaking();
    });
    connect(this, &ShellController::voiceStatePushed, this, [this](const QJsonObject& state) {
        m_voice->applyServerState(state);
        // Cut spoken replies short when the user turned them off.
        if (m_voice->state() == u"speaking" && !m_voice->speakReplies())
            stopSpeaking();
    });
    connect(m_system, &SystemModel::changed, this, [this] {
        m_voice->setAvailability(m_system->voiceAvailable(), m_system->voiceStt(), m_system->voiceTts());
        updateVoiceBlock();
    });
    connect(this, &ShellController::lockedChanged, this, &ShellController::updateVoiceBlock);
    connect(this, &ShellController::connectionChanged, this, &ShellController::updateVoiceBlock);
    updateVoiceBlock();
    connect(this, &ShellController::pairingPushed, this, [this](const QJsonObject& pending) {
        if (m_pairing->load(pending))
            setView(u"chat"_s);
    });
    connect(m_pairing, &PairingModel::answered, this, &ShellController::answerPairing);

    // Rafiq v1.1 contracts §2: computer use.
    connect(m_cu, &CuSessionModel::stopRequested, this, [this] {
        request(u"cu:stop"_s, QJsonArray{}, [this](const ControlResult& r) { m_cu->applyRequestResult(r.ok, r.text); });
    });
    connect(m_cu, &CuSessionModel::resumeRequested, this, [this] {
        request(u"cu:resume"_s, QJsonArray{}, [this](const ControlResult& r) { m_cu->applyRequestResult(r.ok, r.text); });
    });
    connect(m_cu, &CuSessionModel::runningChanged, this, [this] {
        // jarvis-cu refuses input while the shell has focus (contracts §1):
        // step aside when Jarvis (re)starts, unless a card still waits.
        if (m_cu->running() && m_surfaceShown && !m_chatCard->active())
            emit dismissRequested();
    });
    connect(m_cuSettings, &CuSettingsModel::consentRequested, this, [this](const QString& id) {
        request(u"cu:consent"_s, QJsonArray{QJsonObject{{"providerId", id}}}, [this, id](const ControlResult& r) {
            m_cuSettings->applyConsentResult(id, r.ok, r.code, r.text);
        });
    });
    connect(m_cuSettings, &CuSettingsModel::setEnabledRequested, this, [this](const QString& id, bool enabled) {
        request(u"cu:setEnabled"_s, QJsonArray{QJsonObject{{"providerId", id}, {"enabled", enabled}}},
                [this, id, enabled](const ControlResult& r) {
                    m_cuSettings->applyEnabledResult(id, enabled, r.ok, r.code, r.text);
                });
    });
    // Plan Y §2.4: account sign-in.
    connect(m_accounts, &AccountsModel::statusRequested, this, [this] {
        request(u"account:status"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (r.ok)
                m_accounts->applyStatus(r.value.toObject());
        });
    });
    const auto accountResult = [this](const QString& account, bool refreshAfter) {
        return [this, account, refreshAfter](const ControlResult& r) {
            if (!r.ok)
                m_accounts->applyRequestError(account, r.text);
            if (refreshAfter)
                m_accounts->refresh();
        };
    };
    connect(m_accounts, &AccountsModel::installRequested, this, [this, accountResult](const QString& a) {
        request(u"account:install"_s, QJsonArray{QJsonObject{{"account", a}}}, accountResult(a, false));
    });
    connect(m_accounts, &AccountsModel::loginRequested, this, [this, accountResult](const QString& a) {
        request(u"account:login"_s, QJsonArray{QJsonObject{{"account", a}}}, accountResult(a, false));
    });
    connect(m_accounts, &AccountsModel::logoutRequested, this, [this, accountResult](const QString& a) {
        request(u"account:logout"_s, QJsonArray{QJsonObject{{"account", a}}}, accountResult(a, true));
    });
    connect(m_accounts, &AccountsModel::uninstallRequested, this, [this, accountResult](const QString& a) {
        request(u"account:uninstall"_s, QJsonArray{QJsonObject{{"account", a}}}, accountResult(a, true));
    });
    connect(m_accounts, &AccountsModel::signedIn, this, [this](const QString& account) {
        m_accounts->refresh();
        // Setup/Settings: the account just signed in is the provider being edited → check it now.
        if (m_provider->mode() == u"account" && m_provider->account() == account)
            m_provider->probe();
    });
}

void ShellController::request(const QString& channel, const QJsonArray& args,
                              std::function<void(const ControlResult&)> done)
{
    QPointer<ShellController> self(this);
    m_client->invoke(channel, args, [self, done = std::move(done)](const ControlResult& result) {
        if (self && done)
            done(result);
    });
}

bool ShellController::offerDoctor() const
{
    return m_connection == u"open" && !m_providerReachable && m_system->known() && !m_system->online();
}

void ShellController::setClassicSwitcher(ClassicSwitcher switcher)
{
    m_classicSwitcher = std::move(switcher);
    emit bannerChanged();
}

void ShellController::setClassicOfferDelay(int ms)
{
    m_daemonDownTimer->setInterval(ms);
    if (m_daemonDownTimer->isActive())
        m_daemonDownTimer->start();
}

void ShellController::setDaemonDown(bool down)
{
    if (down == m_daemonDown)
        return;
    m_daemonDown = down;
    emit bannerChanged();
}

void ShellController::switchToClassic()
{
    if (m_classicSwitcher)
        m_classicSwitcher();
}

QString ShellController::bannerText() const
{
    if (offerClassic())
        return tr("Jarvis isn't responding. Keep waiting, or switch to classic mode.");
    if (m_connection == u"connecting")
        return tr("Connecting to Jarvis…");
    if (m_connection == u"reconnecting")
        return tr("Lost the connection to Jarvis. Reconnecting…");
    if (!m_providerReachable) {
        const QString who = m_provider->activeModel().isEmpty() ? tr("the model provider") : m_provider->activeModel();
        return m_providerError.isEmpty() ? tr("Can't reach %1.").arg(who)
                                         : tr("Can't reach %1: %2").arg(who, m_providerError);
    }
    if (!m_fallbackReason.isEmpty()) // design §3.5: "Using <provider> — <reason>"
        return tr("Using %1 — %2").arg(m_providers->displayName(m_providers->activeId()), m_fallbackReason);
    return {};
}

void ShellController::setView(QString view)
{
    if (view == u"chat" && m_provider->known() && !m_provider->hasActive())
        view = u"setup"_s;
    if (view == m_view)
        return;
    m_view = view;
    emit viewChanged();
}

void ShellController::setConnection(const QString& connection)
{
    if (connection == m_connection)
        return;
    m_connection = connection;
    if (connection == u"open") {
        m_daemonDownTimer->stop();
        setDaemonDown(false);
    } else if (!m_daemonDownTimer->isActive() && !m_daemonDown) {
        m_daemonDownTimer->start();
    }
    emit connectionChanged();
    emit bannerChanged();
    emit providerStatusChanged(); // offerDoctor depends on the connection
}

void ShellController::refreshProviders()
{
    request(u"provider:list"_s, QJsonArray{}, [this](const ControlResult& r) {
        if (!r.ok)
            return;
        m_provider->loadList(r.value.toObject());
        m_providers->loadList(r.value.toObject());
        m_cuSettings->loadList(r.value.toObject());
        if (!m_provider->hasActive() && m_view != u"doctor") // the doctor may run before any provider exists
            setView(u"setup"_s);
        else if (m_view == u"loading" || m_view == u"setup")
            setView(u"chat"_s);
    });
}

void ShellController::onOpened()
{
    m_accounts->refresh();
    m_cu->connectionOpened(); // jarvisd re-pushes cu:state for a session still running
    setConnection(u"open"_s);
    refreshProviders();
    m_audit->refresh();
    if (m_view == u"doctor")
        m_doctor->start();
}

void ShellController::onClosed()
{
    setConnection(u"reconnecting"_s);
    m_conversation->markInterrupted();
    m_cu->connectionClosed();
    // Cards cannot be answered without a connection; jarvisd re-pushes every
    // open card on reconnect (§6.7). m_chatCardIds is kept so the eventual
    // card-closed still adds exactly one notice.
    const bool hadCard = m_chatCard->active() || m_doctorCard->active();
    m_chatCard->close();
    m_doctorCard->close();
    m_pairing->close();
    if (hadCard)
        m_conversation->addNotice(
            tr("Lost the connection to Jarvis. Open approval cards come back when it reconnects; an unanswered card counts as Deny."));
}

void ShellController::onPush(const QString& channel, const QJsonValue& payload)
{
    if (channel == u"agent:events")
        return onAgentEvent(payload.toObject());
    if (channel == u"voice:state")
        return emit voiceStatePushed(payload.toObject());
    if (channel == u"pairing:pending")
        return emit pairingPushed(payload.toObject());
    if (channel == u"remote:status")
        return m_phone->applyStatus(payload.toObject());
    if (channel == u"provider:status") {
        const QJsonObject status = payload.toObject();
        m_providerReachable = status.value("reachable").toBool(true);
        m_providerError = status.value("error").toString();
        m_fallbackReason = status.value("fallbackReason").toString();
        const QString activeId = status.value("activeId").toString();
        if (!activeId.isEmpty()) {
            m_providers->setActiveId(activeId);
            const QJsonObject config = m_providers->configFor(activeId);
            if (!config.isEmpty())
                m_provider->loadActive(config);
        }
        emit providerStatusChanged();
        emit bannerChanged();
        return maybeLeaveDoctor();
    }
    if (channel == u"doctor:state") {
        m_doctor->applyState(payload.toObject());
        return maybeLeaveDoctor();
    }
    if (channel == u"ui:language") {
        // Rafiq M4 contracts §3. Anything but {lang: "en"|"ar"} is ignored.
        const QJsonValue lang = payload.toObject().value("lang");
        if (payload.isObject() && lang.isString())
            applyLanguage(lang.toString());
        return;
    }
    if (channel == u"account:state") {
        if (payload.isObject())
            m_accounts->applyState(payload.toObject());
        return;
    }
    if (channel == u"cu:state") {
        if (payload.isObject())
            m_cu->applyState(payload.toObject());
        return;
    }
    if (channel == u"sys:snapshot") {
        const QJsonObject snap = payload.toObject();
        m_system->applySnapshot(snap);
        if (const QJsonValue speak = snap.value("voice").toObject().value("speak"); speak.isBool())
            m_voice->applySnapshotSpeak(speak.toBool());
        // jarvisd's undo stack is authoritative when it reports one (M3 contracts §5 #10);
        // otherwise keep the local inference from approved cards.
        if (const QJsonValue undo = snap.value("undo"); undo.isObject()) {
            const bool available = undo.toObject().value("available").toBool(false);
            if (available != m_undoAvailable) {
                m_undoAvailable = available;
                emit undoChanged();
            }
        }
    }
}

void ShellController::onAgentEvent(const QJsonObject& event)
{
    const QString type = event.value("type").toString();
    if (type == u"card") {
        const QJsonObject card = event.value("card").toObject();
        const QString cardId = card.value("cardId").toString();
        if (cardId.isEmpty() || m_chatCard->cardId() == cardId || m_doctorCard->cardId() == cardId)
            return; // a re-push of a card already shown (§6.7)
        const bool forDoctor = !card.value("turnId").isString() && (m_view == u"doctor" || m_doctor->active());
        CardModel* target = forDoctor ? m_doctorCard : m_chatCard;
        if (target->load(card) && !forDoctor) {
            m_chatCardIds.insert(target->cardId());
            if (m_cu->active() || isComputerUseCard(card))
                emit summonRequested();
        }
        return;
    }
    if (type == u"card-closed") {
        const QString cardId = event.value("cardId").toString();
        if (cardId.isEmpty())
            return;
        if (m_chatCard->cardId() == cardId)
            m_chatCard->close();
        if (m_doctorCard->cardId() == cardId)
            m_doctorCard->close();
        if (m_chatCardIds.remove(cardId)) {
            const QString decision = event.value("decision").toString();
            if (decision == u"approved") {
                m_conversation->addNotice(tr("Approved."));
                m_undoAvailable = true; // agent:undo can now restore it (M3 contracts §2)
                emit undoChanged();
            }
            else if (decision == u"timeout")
                m_conversation->addNotice(tr("No answer in 5 minutes. Nothing was changed."));
            else
                m_conversation->addNotice(tr("Denied. Nothing was changed."));
        }
        m_audit->refresh();
        return;
    }
    m_conversation->applyEvent(event);
    if (type == u"turn-end")
        m_audit->refresh();
}

void ShellController::maybeLeaveDoctor()
{
    if (m_view == u"doctor" && m_doctor->done() == u"fixed" && m_providerReachable && m_connection == u"open") {
        setView(u"chat"_s);
        m_conversation->addNotice(tr("Network doctor fixed the connection."));
    }
}

bool ShellController::sendPrompt(const QString& text)
{
    const QString prompt = text.trimmed();
    if (prompt.isEmpty())
        return false;
    if (prompt.size() > kMaxPromptLength) {
        m_conversation->addNotice(tr("That message is too long (8000 characters at most)."));
        return false;
    }
    request(u"agent:prompt"_s, QJsonArray{QJsonObject{{"text", prompt}}}, [this](const ControlResult& r) {
        if (!r.ok)
            m_conversation->addNotice(tr("Jarvis couldn't take that message: %1").arg(r.text));
    });
    return true;
}

void ShellController::stop()
{
    if (!m_conversation->busy())
        return;
    request(u"agent:stop"_s, QJsonArray{QJsonObject{{"turnId", m_conversation->activeTurnId()}}});
}

void ShellController::escape()
{
    if (m_voice->recording())
        return m_voice->cancel();
    if (m_voice->state() == u"speaking")
        return stopSpeaking();
    if (m_conversation->busy())
        return stop();
    if (m_view == u"audit" || m_view == u"settings" || m_view == u"doctor")
        return setView(u"chat"_s);
    emit dismissRequested();
}

void ShellController::applyLockState()
{
    const bool locked = m_system->locked();
    m_chatCard->setLocked(locked);
    m_doctorCard->setLocked(locked);
    m_pairing->setLocked(locked);
    if (locked == m_locked)
        return;
    m_locked = locked;
    emit undoChanged();
    emit lockedChanged();
}

void ShellController::decide(CardModel* card, bool approve)
{
    if (!card || !card->active())
        return; // already answered: a double click sends nothing
    if (m_locked) {
        // M3 contracts §2: jarvisd refuses agent:confirm while locked. Keep the card.
        m_conversation->addNotice(tr("The screen is locked. Unlock it to answer this card."));
        return;
    }
    const QJsonObject source = card->source();
    const QJsonObject payload = card->decision(approve);
    card->close();
    // Back to the app Jarvis works in: the shell itself is never controllable.
    if (m_cu->active() && card == m_chatCard)
        emit dismissRequested();
    QPointer<CardModel> target(card);
    request(u"agent:confirm"_s, QJsonArray{payload}, [this, target, source](const ControlResult& r) {
        if (r.ok)
            return;
        if (r.code == u"locked" && target && !target->active() && target->load(source)) {
            m_conversation->addNotice(tr("The screen is locked. Unlock it to answer this card."));
            return;
        }
        m_conversation->addNotice(
            tr("Couldn't send your answer to Jarvis (%1). An unanswered card counts as Deny.").arg(r.text));
    });
}

void ShellController::undo()
{
    if (m_undoing || !undoAvailable())
        return;
    m_undoing = true;
    emit undoChanged();
    request(u"agent:undo"_s, QJsonArray{}, [this](const ControlResult& r) {
        m_undoing = false;
        if (!r.ok) {
            m_conversation->addNotice(tr("Couldn't undo: %1").arg(r.text));
        } else if (const QString title = r.value.toObject().value("undone").toString(); title.isEmpty()) {
            m_undoAvailable = false;
            m_conversation->addNotice(tr("Nothing left to undo."));
        } else {
            m_conversation->addNotice(tr("Undid: %1").arg(title.left(200)));
        }
        emit undoChanged();
    });
}

void ShellController::stopSpeaking()
{
    request(u"voice:stop"_s, QJsonArray{});
}

void ShellController::answerPairing(const QString& requestId, bool approve)
{
    // M3 contracts §5 #9: pairing:answer [{requestId, approve}], requestId from the pairing:pending push.
    if (approve && m_locked) {
        m_conversation->addNotice(tr("The screen is locked. Unlock it to allow a new phone."));
        return;
    }
    request(u"pairing:answer"_s, QJsonArray{QJsonObject{{"requestId", requestId}, {"approve", approve}}}, [this](const ControlResult& r) {
        if (!r.ok)
            m_conversation->addNotice(tr("Couldn't send the pairing answer (%1).").arg(r.text));
    });
}

void ShellController::sendUtterance(const QByteArray& wav, const QJsonObject& header,
                                    std::function<void(const ControlResult&)> done)
{
    QPointer<ShellController> self(this);
    m_client->upload(u"voice:utterance"_s, QJsonArray{header}, wav, [self, done = std::move(done)](const ControlResult& r) {
        if (self && done)
            done(r);
    });
}

void ShellController::showView(const QString& view)
{
    if (view == u"doctor")
        return openDoctor();
    if (view != u"chat" && view != u"audit" && view != u"settings")
        return;
    if (view == u"audit")
        m_audit->refresh();
    if (view == u"settings") {
        m_accounts->refresh();
        m_provider->editActive();
        refreshProviders();
        m_memory->refresh();
        m_registry->refresh();
        m_phone->refresh();
    }
    setView(view);
}

void ShellController::openDoctor()
{
    setView(u"doctor"_s);
    m_doctor->start();
}

void ShellController::openTerminal()
{
    if (!m_launcher || !m_launcher(u"foot"_s)) {
        m_conversation->addNotice(tr("Couldn't open a terminal: foot is not installed."));
        return;
    }
    emit dismissRequested();
}

void ShellController::requestComposerFocus()
{
    emit composerFocusRequested();
}

void ShellController::askForUpdates()
{
    // Spec §8: "update my computer" -> jarvisd runs updates.list and shows one batch card.
    showView(u"chat"_s);
    sendPrompt(tr("Update my computer"));
}

void ShellController::checkForUpdates()
{
    if (m_updatesChecking)
        return;
    m_updatesChecking = true;
    m_updatesNote.clear();
    emit updatesChanged();
    // M2 contracts §2: updates:check → {count, security}; errors unsupported | internal with a message.
    request(u"updates:check"_s, QJsonArray{}, [this](const ControlResult& r) {
        m_updatesChecking = false;
        if (r.ok) {
            const QJsonObject v = r.value.toObject();
            m_system->applyUpdateCounts(v.value("count").toInt(), v.value("security").toInt());
            m_updatesNote = v.value("count").toInt() > 0 ? QString() : tr("Everything is up to date.");
        } else if (!r.text.isEmpty()) {
            m_updatesNote = r.text;
        } else {
            m_updatesNote = r.code == u"unsupported" ? tr("This system can't check for updates yet.")
                                                    : tr("Couldn't check for updates.");
        }
        emit updatesChanged();
    });
}

void ShellController::askJarvis(const QString& text)
{
    setView(u"chat"_s);
    if (m_conversation->busy()) {
        m_conversation->addNotice(tr("Jarvis is busy. Try again when the reply finishes."));
        return;
    }
    sendPrompt(text);
}

void ShellController::updateVoiceBlock()
{
    if (m_locked)
        m_voice->setBlocked(true, tr("Voice is off while the screen is locked."));
    else if (m_connection != u"open")
        m_voice->setBlocked(true, tr("Voice needs the connection to Jarvis."));
    else
        m_voice->setBlocked(false);
}

CardModel* ShellController::voiceCard() const
{
    // Design §3.2 ruling: voice answers only a card the user can see right
    // now, on an unlocked screen, that needs no password or typed secret.
    if (m_locked || !m_surfaceShown)
        return nullptr;
    CardModel* card = m_view == u"chat" ? m_chatCard : m_view == u"doctor" ? m_doctorCard : nullptr;
    return card && card->voiceAnswerable() ? card : nullptr;
}

void ShellController::pushToTalk()
{
    if (m_view != u"chat" && m_view != u"doctor")
        setView(u"chat"_s);
    m_voice->toggle();
}

void ShellController::onUtterance(const QByteArray& wav)
{
    if (m_locked) { // never upload audio recorded across a lock
        m_voice->resultArrived();
        return;
    }
    QJsonObject header{{"lang", "auto"}};
    QString sentCardId;
    if (const CardModel* card = voiceCard()) {
        sentCardId = card->cardId();
        header.insert("cardId", sentCardId);
    }
    sendUtterance(wav, header, [this, sentCardId](const ControlResult& r) {
        m_voice->resultArrived();
        if (!r.ok) {
            m_conversation->addNotice(tr("Voice didn't work: %1").arg(r.text));
            return;
        }
        applyVoiceResult(r.value.toObject(), sentCardId);
    });
}

void ShellController::applyVoiceResult(const QJsonObject& result, const QString& sentCardId)
{
    const QString action = result.value("action").toString();
    const QString heard = result.value("text").toString().simplified().left(200);
    if (action == u"approve" || action == u"deny") {
        CardModel* card = voiceCard();
        // The very card we sent must still be open, visible and answerable.
        if (sentCardId.isEmpty() || !card || card->cardId() != sentCardId) {
            m_conversation->addNotice(tr("Jarvis heard “%1”, but that card is gone. Nothing was changed.").arg(heard));
            return;
        }
        const bool approve = action == u"approve";
        m_conversation->addNotice(approve ? tr("You said yes.") : tr("You said no."));
        decide(card, approve);
        return;
    }
    if (action == u"ignored") {
        m_conversation->addNotice(heard.isEmpty() ? tr("Jarvis didn't hear anything. Try again.")
                                                  : tr("Jarvis didn't catch that. Try again."));
        return;
    }
    // "prompt" (ruling R1): jarvisd already started the turn; its turn-start
    // event puts the words in the chat. Sending agent:prompt would run it twice.
}

bool ShellController::handleInstanceMessage(const QByteArray& message)
{
    if (message == "focus") {
        requestComposerFocus();
        return true;
    }
    if (message == "ptt") { // Super+Space (labwc) -> jarvis-shell --voice
        setSurfaceShown(true);
        pushToTalk();
        return true;
    }
    if (message == "cu-stop") { // Super+Esc (labwc) -> jarvis-shell --cu-stop: Take over
        m_cu->stop();          // no-op without a running or paused session
        return true;
    }
    return false;
}

void ShellController::setLanguageApplier(LanguageApplier applier, const QString& current)
{
    m_languageApplier = std::move(applier);
    m_language = jarvis::ui::isSupportedLanguage(current) ? current : u"en"_s;
    emit languageChanged();
}

void ShellController::chooseLanguage(const QString& code)
{
    if (!jarvis::ui::isSupportedLanguage(code) || m_languageBusy)
        return;
    if (code == m_language && m_languageNote.isEmpty())
        return;
    m_languageBusy = true;
    m_languageNote.clear();
    emit languageChanged();
    request(u"ui:setLanguage"_s, QJsonArray{QJsonObject{{"lang", code}}}, [this, code](const ControlResult& r) {
        m_languageBusy = false;
        if (r.ok) {
            applyLanguage(code); // the ui:language push that follows is then a no-op
            emit languageChanged();
            return;
        }
        m_languageNote = r.code == u"unsupported"
                             ? tr("This version of Jarvis can't change the language yet.")
                             : tr("Couldn't change the language: %1").arg(r.text);
        emit languageChanged();
    });
}

void ShellController::applyLanguage(const QString& code)
{
    if (!jarvis::ui::isSupportedLanguage(code))
        return;
    if (code == m_language && m_languageNote.isEmpty())
        return;
    if (m_languageApplier && !m_languageApplier(code)) {
        m_languageNote = tr("Arabic isn't installed on this computer, so Jarvis stays in English.");
        emit languageChanged();
        return;
    }
    m_language = code;
    m_languageNote.clear();
    refreshTranslatedText();
    emit languageChanged();
}

// Text built in C++ with tr() is computed on read, but QML only re-reads a
// property when its NOTIFY fires: announce every translated property again.
// Nothing is reloaded or re-sent; cards keep their ticks and timers.
void ShellController::refreshTranslatedText()
{
    for (QAbstractListModel* model : std::initializer_list<QAbstractListModel*>{
             m_chatCard, m_doctorCard, m_providers, m_registry, m_audit, m_memory, m_doctor, m_cu, m_cuSettings, m_accounts}) {
        if (const int rows = model->rowCount(); rows > 0)
            emit model->dataChanged(model->index(0), model->index(rows - 1));
    }
    emit m_chatCard->changed();
    emit m_doctorCard->changed();
    emit m_system->changed();
    emit m_provider->activeChanged();
    emit m_provider->draftChanged();
    emit m_provider->probeChanged();
    emit m_providers->changed();
    emit m_registry->changed();
    emit m_audit->entriesChanged();
    emit m_memory->changed();
    emit m_doctor->stateChanged();
    emit m_voice->changed();   // Plan O Task 7 VoiceModel
    emit m_pairing->changed(); // Plan O Task 10 PairingModel
    emit m_accounts->changed();
    emit m_cu->changed();
    emit m_cuSettings->changed();
    emit bannerChanged();
    emit providerStatusChanged();
    emit updatesChanged();
}
