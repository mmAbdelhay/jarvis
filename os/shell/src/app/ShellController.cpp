#include "app/ShellController.h"

#include <QPointer>
#include <QProcess>

#include "control/ControlClient.h"

using namespace Qt::StringLiterals;

namespace {
constexpr int kMaxPromptLength = 8000; // contracts §3.1 agent:prompt
}

ShellController::ShellController(ControlClient* client, QObject* parent)
    : QObject(parent)
    , m_client(client)
    , m_conversation(new Conversation(this))
    , m_chatCard(new CardModel(this))
    , m_doctorCard(new CardModel(this))
    , m_provider(new ProviderModel(this))
    , m_providers(new ProviderListModel(this))
    , m_doctor(new DoctorModel(this))
    , m_audit(new AuditModel(this))
    , m_system(new SystemModel(this))
    , m_launcher([](const QString& program) { return QProcess::startDetached(program, {}); })
{
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

    connect(m_doctor, &DoctorModel::startRequested, this, [this] {
        request(u"doctor:start"_s, QJsonArray{}, [this](const ControlResult& r) {
            if (r.ok)
                m_doctor->applyState(r.value.toObject());
            else
                m_conversation->addNotice(u"Network doctor couldn't start: %1"_s.arg(r.text));
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

QString ShellController::bannerText() const
{
    if (m_connection == u"connecting")
        return u"Connecting to Jarvis…"_s;
    if (m_connection == u"reconnecting")
        return u"Lost the connection to Jarvis. Reconnecting…"_s;
    if (!m_providerReachable) {
        const QString who = m_provider->activeModel().isEmpty() ? u"the model provider"_s : m_provider->activeModel();
        return m_providerError.isEmpty() ? u"Can't reach %1."_s.arg(who)
                                         : u"Can't reach %1: %2"_s.arg(who, m_providerError);
    }
    if (!m_fallbackReason.isEmpty()) // design §3.5: "Using <provider> — <reason>"
        return u"Using %1 — %2"_s.arg(m_providers->displayName(m_providers->activeId()), m_fallbackReason);
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
        if (!m_provider->hasActive() && m_view != u"doctor") // the doctor may run before any provider exists
            setView(u"setup"_s);
        else if (m_view == u"loading" || m_view == u"setup")
            setView(u"chat"_s);
    });
}

void ShellController::onOpened()
{
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
    // Cards cannot be answered without a connection; jarvisd re-pushes every
    // open card on reconnect (§6.7). m_chatCardIds is kept so the eventual
    // card-closed still adds exactly one notice.
    const bool hadCard = m_chatCard->active() || m_doctorCard->active();
    m_chatCard->close();
    m_doctorCard->close();
    if (hadCard)
        m_conversation->addNotice(
            u"Lost the connection to Jarvis. Open approval cards come back when it reconnects; an unanswered card counts as Deny."_s);
}

void ShellController::onPush(const QString& channel, const QJsonValue& payload)
{
    if (channel == u"agent:events")
        return onAgentEvent(payload.toObject());
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
    if (channel == u"sys:snapshot")
        m_system->applySnapshot(payload.toObject());
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
        if (target->load(card) && !forDoctor)
            m_chatCardIds.insert(target->cardId());
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
            if (decision == u"approved")
                m_conversation->addNotice(u"Approved."_s);
            else if (decision == u"timeout")
                m_conversation->addNotice(u"No answer in 5 minutes. Nothing was changed."_s);
            else
                m_conversation->addNotice(u"Denied. Nothing was changed."_s);
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
        m_conversation->addNotice(u"Network doctor fixed the connection."_s);
    }
}

bool ShellController::sendPrompt(const QString& text)
{
    const QString prompt = text.trimmed();
    if (prompt.isEmpty())
        return false;
    if (prompt.size() > kMaxPromptLength) {
        m_conversation->addNotice(u"That message is too long (8000 characters at most)."_s);
        return false;
    }
    request(u"agent:prompt"_s, QJsonArray{QJsonObject{{"text", prompt}}}, [this](const ControlResult& r) {
        if (!r.ok)
            m_conversation->addNotice(u"Jarvis couldn't take that message: %1"_s.arg(r.text));
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
    if (m_conversation->busy())
        return stop();
    if (m_view == u"audit" || m_view == u"settings" || m_view == u"doctor")
        return setView(u"chat"_s);
    emit dismissRequested();
}

void ShellController::decide(CardModel* card, bool approve)
{
    if (!card || !card->active())
        return; // already answered: a double click sends nothing
    const QJsonObject payload = card->decision(approve);
    card->close();
    request(u"agent:confirm"_s, QJsonArray{payload}, [this](const ControlResult& r) {
        if (!r.ok)
            m_conversation->addNotice(
                u"Couldn't send your answer to Jarvis (%1). An unanswered card counts as Deny."_s.arg(r.text));
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
        m_provider->editActive();
        refreshProviders();
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
        m_conversation->addNotice(u"Couldn't open a terminal: foot is not installed."_s);
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
    sendPrompt(u"Update my computer"_s);
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
            m_updatesNote = v.value("count").toInt() > 0 ? QString() : u"Everything is up to date."_s;
        } else if (!r.text.isEmpty()) {
            m_updatesNote = r.text;
        } else {
            m_updatesNote = r.code == u"unsupported" ? u"This system can't check for updates yet."_s
                                                    : u"Couldn't check for updates."_s;
        }
        emit updatesChanged();
    });
}
