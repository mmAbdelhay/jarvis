#include "models/ProviderModel.h"

#include <QHostAddress>
#include <QJsonArray>
#include <QUrl>

using namespace Qt::StringLiterals;

namespace {

struct Preset {
    QStringView name;
    QStringView kind;
    QStringView baseUrl;
};

constexpr Preset kPresets[] = {
    {u"Anthropic", u"anthropic", u"https://api.anthropic.com"},
    {u"Gemini", u"gemini", u"https://generativelanguage.googleapis.com"},
    {u"OpenAI", u"openai-compatible", u"https://api.openai.com/v1"},
    {u"OpenRouter", u"openai-compatible", u"https://openrouter.ai/api/v1"},
    {u"Groq", u"openai-compatible", u"https://api.groq.com/openai/v1"},
    {u"DeepSeek", u"openai-compatible", u"https://api.deepseek.com/v1"},
    {u"xAI", u"openai-compatible", u"https://api.x.ai/v1"},
    {u"Mistral", u"openai-compatible", u"https://api.mistral.ai/v1"},
    {u"Custom URL", u"openai-compatible", u""},
};

const Preset* presetNamed(const QString& name)
{
    for (const Preset& preset : kPresets)
        if (preset.name == name)
            return &preset;
    return nullptr;
}

const Preset* presetFor(const QString& kind, const QString& url)
{
    QString normalized = url.trimmed();
    while (normalized.endsWith(u'/'))
        normalized.chop(1);
    for (const Preset& preset : kPresets)
        if (!preset.baseUrl.isEmpty() && preset.kind == kind && preset.baseUrl == normalized)
            return &preset;
    return nullptr;
}

bool isLoopbackHost(const QString& host)
{
    return host == u"localhost" || QHostAddress(host).isLoopback();
}

bool isPrivateHost(const QString& host)
{
    return host.endsWith(u".local") || QHostAddress(host).isPrivateUse();
}

QString modeFor(const QString& kind, const QString& url)
{
    const QString host = QUrl(url).host();
    if (kind == u"ollama")
        return isLoopbackHost(host) ? u"local"_s : u"lan"_s;
    if (kind == u"anthropic" || kind == u"gemini" || presetFor(kind, url))
        return u"cloud"_s;
    return isLoopbackHost(host) || isPrivateHost(host) ? u"lan"_s : u"cloud"_s;
}

} // namespace

ProviderModel::ProviderModel(QObject* parent)
    : QObject(parent)
{
    setMode(u"cloud"_s);
}

ProviderModel::~ProviderModel()
{
    wipeKey();
}

QStringList ProviderModel::presetNames() const
{
    QStringList names;
    for (const Preset& preset : kPresets)
        names.append(preset.name.toString());
    return names;
}

QString ProviderModel::providerMode(const QString& kind, const QString& url)
{
    return modeFor(kind, url);
}

QString ProviderModel::providerLabel(const QString& kind, const QString& url)
{
    const QString mode = modeFor(kind, url);
    if (mode == u"local")
        return u"On this computer"_s;
    if (mode == u"lan")
        return u"On your network"_s;
    if (kind == u"anthropic")
        return u"Anthropic"_s;
    if (kind == u"gemini")
        return u"Gemini"_s;
    if (const Preset* preset = presetFor(kind, url))
        return preset->name.toString();
    return QUrl(url).host();
}

QString ProviderModel::activeLabel() const
{
    return m_hasActive ? providerLabel(m_activeKind, m_activeBaseUrl) : QString();
}

QString ProviderModel::suggestedId() const
{
    if (m_mode != u"cloud")
        return m_mode;
    QString slug;
    for (const QChar c : m_preset.toLower())
        if (c.unicode() < 128 && c.isLetterOrNumber())
            slug.append(c);
    return slug.isEmpty() || slug == u"customurl" ? u"cloud"_s : slug.left(32);
}

void ProviderModel::setMode(const QString& mode)
{
    if (mode != u"cloud" && mode != u"local" && mode != u"lan")
        return;
    m_mode = mode;
    m_models.clear();
    m_model.clear();
    if (mode == u"cloud") {
        const Preset* preset = presetNamed(u"Anthropic"_s);
        m_preset = preset->name.toString();
        m_kind = preset->kind.toString();
        m_baseUrl = preset->baseUrl.toString();
    } else {
        m_preset.clear();
        m_kind = u"ollama"_s;
        m_baseUrl = mode == u"local" ? u"http://localhost:11434"_s : QString();
    }
    resetProbe();
    emit draftChanged();
}

void ProviderModel::setPreset(const QString& name)
{
    const Preset* preset = presetNamed(name);
    if (!preset || m_mode != u"cloud")
        return;
    m_preset = name;
    m_kind = preset->kind.toString();
    m_baseUrl = preset->baseUrl.toString();
    m_model.clear();
    m_models.clear();
    resetProbe();
    emit draftChanged();
}

void ProviderModel::setKind(const QString& kind)
{
    if (kind == m_kind || (kind != u"anthropic" && kind != u"gemini" && kind != u"openai-compatible" && kind != u"ollama"))
        return;
    m_kind = kind;
    m_models.clear();
    resetProbe();
    emit draftChanged();
}

void ProviderModel::setBaseUrl(const QString& url)
{
    if (url == m_baseUrl)
        return;
    m_baseUrl = url;
    m_models.clear();
    resetProbe();
    emit draftChanged();
}

void ProviderModel::setModel(const QString& model)
{
    if (model == m_model)
        return;
    m_model = model;
    resetProbe();
    emit draftChanged();
}

void ProviderModel::setApiKey(const QString& key)
{
    if (key == m_apiKey)
        return;
    m_apiKey = key;
    resetProbe();
    emit draftChanged();
}

QString ProviderModel::privacyText() const
{
    if (m_mode == u"cloud")
        return u"When diagnosing problems, Jarvis sends short excerpts of system logs to %1. Passwords, keys and tokens are removed first."_s
            .arg(displayName());
    return u"Diagnosis logs stay on your own machines."_s;
}

QString ProviderModel::displayName() const
{
    const QString host = QUrl(m_baseUrl).host();
    if (m_mode == u"local")
        return u"Ollama"_s;
    if (m_mode == u"lan")
        return host.isEmpty() ? u"the server"_s : host;
    if (m_preset == u"Custom URL")
        return host.isEmpty() ? u"your provider"_s : host;
    return m_preset;
}

QString ProviderModel::statusText() const
{
    if (m_probeState == u"probing")
        return u"Checking %1…"_s.arg(displayName());
    if (m_probeState == u"saving")
        return u"Saving…"_s;
    if (m_probeState == u"ok")
        return u"Connected to %1. Tool calling works, so Jarvis can control this computer."_s.arg(displayName());
    if (m_probeState == u"warn" && m_model.isEmpty())
        return u"Connected to %1, but no models are available. Pull or enter a model first."_s.arg(displayName());
    if (m_probeState == u"warn")
        return u"Connected to %1, but %2 can't call tools: Jarvis can chat but can't control the OS."_s
            .arg(displayName(), m_model);
    if (m_probeState == u"error")
        return m_error.isEmpty() ? u"Couldn't connect to %1."_s.arg(displayName()) : m_error;
    return {};
}

bool ProviderModel::canSave() const
{
    return (m_probeState == u"ok" || m_probeState == u"warn") && !m_model.isEmpty();
}

bool ProviderModel::keepsSavedKey() const
{
    return m_editingHasKey && m_kind == m_editingKind && m_baseUrl.trimmed() == m_editingBaseUrl;
}

QJsonObject ProviderModel::draft() const
{
    QJsonObject out{{"kind", m_kind}, {"baseUrl", m_baseUrl.trimmed()}, {"model", m_model}};
    if (!m_apiKey.isEmpty())
        out.insert("apiKey", m_apiKey);
    return out;
}

void ProviderModel::resetProbe()
{
    m_probeState = u"idle"_s;
    m_error.clear();
    m_autoProbed = false;
    emit probeChanged();
}

void ProviderModel::fail(const QString& message)
{
    m_probeState = u"error"_s;
    m_error = message;
    emit probeChanged();
}

void ProviderModel::wipeKey()
{
    m_apiKey.fill(QChar(u'\0'));
    m_apiKey.clear();
}

void ProviderModel::loadList(const QJsonObject& list)
{
    QJsonObject active = list.value("active").toObject(); // jarvisd before M2.5
    const QJsonValue providers = list.value("providers");
    if (providers.isArray()) {
        const QJsonArray rows = providers.toArray();
        const QString activeId = list.value("activeId").toString();
        active = {};
        for (const QJsonValue& row : rows)
            if (!activeId.isEmpty() && row.toObject().value("id").toString() == activeId)
                active = row.toObject();
        if (active.isEmpty() && !rows.isEmpty())
            active = rows.first().toObject();
    }
    m_known = true;
    loadActive(active);
}

void ProviderModel::loadActive(const QJsonObject& active)
{
    m_hasActive = !active.isEmpty();
    m_activeId = active.value("id").toString();
    m_activeKind = active.value("kind").toString();
    m_activeBaseUrl = active.value("baseUrl").toString();
    m_activeModel = active.value("model").toString();
    m_activeHasKey = active.value("hasKey").toBool();
    emit activeChanged();
}

void ProviderModel::editActive()
{
    if (!m_hasActive)
        return startNew();
    loadDraft(QJsonObject{{"id", m_activeId}, {"kind", m_activeKind}, {"baseUrl", m_activeBaseUrl},
                          {"model", m_activeModel}, {"hasKey", m_activeHasKey}});
}

void ProviderModel::editProvider(const QJsonObject& config)
{
    if (config.value("kind").toString().isEmpty())
        return startNew();
    loadDraft(config);
}

void ProviderModel::startNew()
{
    m_editingId.clear();
    m_editingKind.clear();
    m_editingBaseUrl.clear();
    m_editingHasKey = false;
    wipeKey();
    setMode(u"cloud"_s);
}

void ProviderModel::loadDraft(const QJsonObject& config)
{
    const QString kind = config.value("kind").toString();
    const QString baseUrl = config.value("baseUrl").toString();
    const QString model = config.value("model").toString();
    m_editingId = config.value("id").toString();
    m_editingKind = kind;
    m_editingBaseUrl = baseUrl;
    m_editingHasKey = config.value("hasKey").toBool();
    m_mode = modeFor(kind, baseUrl);
    m_preset.clear();
    if (m_mode == u"cloud") {
        const Preset* preset = presetFor(kind, baseUrl);
        m_preset = preset ? preset->name.toString()
                 : kind == u"anthropic" ? u"Anthropic"_s
                 : kind == u"gemini" ? u"Gemini"_s
                 : u"Custom URL"_s;
    }
    m_kind = kind;
    m_baseUrl = baseUrl;
    m_model = model;
    m_models = model.isEmpty() ? QStringList{} : QStringList{model};
    wipeKey();
    resetProbe();
    emit draftChanged();
}
void ProviderModel::probe()
{
    if (m_baseUrl.trimmed().isEmpty())
        return fail(u"Enter the server address first."_s);
    if (needsKey() && m_apiKey.isEmpty() && !keepsSavedKey())
        return fail(u"Enter your API key first."_s);
    m_probeState = u"probing"_s;
    m_error.clear();
    emit probeChanged();
    emit probeRequested(draft());
}

void ProviderModel::applyProbeResult(const QJsonObject& result)
{
    if (m_probeState != u"probing")
        return; // an answer to a draft that has changed since
    m_models.clear();
    for (const QJsonValue& model : result.value("models").toArray())
        if (model.isString() && !model.toString().isEmpty())
            m_models.append(model.toString());
    if (m_model.isEmpty() && !m_models.isEmpty() && !m_autoProbed) {
        m_autoProbed = true;
        m_model = m_models.first();
        emit draftChanged();
        emit probeChanged();
        emit probeRequested(draft());
        return;
    }
    m_supportsTools = result.value("supportsTools").toBool();
    if (result.value("ok").toBool()) {
        m_probeState = m_supportsTools ? u"ok"_s : u"warn"_s;
        m_error.clear();
    } else {
        m_probeState = u"error"_s;
        m_error = result.value("error").toString();
    }
    emit probeChanged();
}

void ProviderModel::save()
{
    if (!canSave())
        return;
    m_probeState = u"saving"_s;
    emit probeChanged();
    emit saveRequested(draft());
}

void ProviderModel::applySaveResult(const QJsonObject& result)
{
    if (m_probeState != u"saving")
        return;
    if (!result.value("ok").toBool()) {
        const QString error = result.value("error").toString();
        return fail(error.isEmpty() ? u"Couldn't save the provider."_s : error);
    }
    wipeKey();
    m_supportsTools = result.value("supportsTools").toBool();
    m_probeState = m_supportsTools ? u"ok"_s : u"warn"_s;
    emit draftChanged();
    emit probeChanged();
    emit saved();
}

void ProviderModel::applyRequestError(const QString& text)
{
    if (m_probeState == u"probing" || m_probeState == u"saving")
        fail(text);
}
