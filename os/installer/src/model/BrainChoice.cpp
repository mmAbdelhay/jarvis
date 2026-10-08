#include "BrainChoice.h"

#include <QUrl>
#include <algorithm>
#include <QVariantMap>

#include "InstallRules.h"

using namespace Qt::StringLiterals;
using namespace jarvis::installer;

BrainChoice::BrainChoice(QObject* parent)
    : QObject(parent)
{
}

void BrainChoice::applyProbe(const QJsonObject& probe)
{
    m_probe = probe;
    refit();
}

void BrainChoice::setTargetBytes(qint64 bytes)
{
    if (bytes == m_target)
        return;
    m_target = bytes;
    refit();
}

void BrainChoice::refit()
{
    m_fit = modelsThatFit(m_probe, m_target);
    const bool stillFits = std::any_of(m_fit.cbegin(), m_fit.cend(),
                                       [this](const QJsonValue& m) { return m.toObject().value("id").toString() == m_modelId; });
    if (!stillFits)
        m_modelId = m_fit.isEmpty() ? QString() : m_fit.at(0).toObject().value("id").toString();
    if (!m_kindChosen)
        m_kind = m_fit.isEmpty() ? u"cloud"_s : u"local"_s; // the default follows what fits
    else if (m_kind == u"local" && m_fit.isEmpty())
        m_kind = u"cloud"_s;
    emit changed();
}

QJsonObject BrainChoice::selected() const
{
    for (const QJsonValue& m : m_fit)
        if (m.toObject().value("id").toString() == m_modelId)
            return m.toObject();
    return {};
}

void BrainChoice::setKind(const QString& kind)
{
    if (kind != u"local" && kind != u"cloud" && kind != u"lan")
        return;
    if (kind == u"local" && m_fit.isEmpty())
        return;
    m_kindChosen = true;
    if (kind == m_kind)
        return;
    m_kind = kind;
    emit changed();
}

void BrainChoice::setModelId(const QString& id)
{
    const bool fits = std::any_of(m_fit.cbegin(), m_fit.cend(),
                                  [&](const QJsonValue& m) { return m.toObject().value("id").toString() == id; });
    if (!fits || id == m_modelId)
        return;
    m_modelId = id;
    emit changed();
}

QVariantList BrainChoice::models() const
{
    QVariantList out;
    for (qsizetype i = 0; i < m_fit.size(); ++i) {
        const QJsonObject m = m_fit.at(i).toObject();
        out.append(QVariantMap{{u"id"_s, m.value("id").toString()},
                               {u"title"_s, m.value("displayName").toString()},
                               {u"detail"_s, u"%1 · %2 download"_s.arg(m.value("recommendedFor").toString(),
                                                                       formatSize(m.value("sizeBytes").toInteger()))},
                               {u"recommended"_s, i == 0}});
    }
    return out;
}

QString BrainChoice::localTitle() const
{
    const QString name = selectedModelName();
    return name.isEmpty() ? u"This computer"_s : u"This computer — %1"_s.arg(name);
}

QString BrainChoice::localDetail() const
{
    const QJsonObject m = selected();
    if (m.isEmpty())
        return u"No tested model fits this computer's memory and disk. Pick Cloud or Network server."_s;
    return u"%1. Private, works offline. %2 download during install."_s.arg(
        m.value("recommendedFor").toString(), formatSize(m.value("sizeBytes").toInteger()));
}

QString BrainChoice::ramText() const
{
    return u"%1 GB"_s.arg(qRound64(m_probe.value("ramBytes").toDouble() / double(GiB)));
}

QString BrainChoice::gpuText() const
{
    const QJsonObject gpu = m_probe.value("gpu").toObject();
    if (gpu.isEmpty())
        return u"None"_s;
    const QString name = gpu.value("name").toString();
    if (!gpu.value("vramBytes").isDouble())
        return name;
    return u"%1 · %2 GB"_s.arg(name).arg(qRound64(gpu.value("vramBytes").toDouble() / double(GiB)));
}

QString BrainChoice::freeText() const { return formatSize(m_target); }

void BrainChoice::setLanUrl(const QString& url)
{
    if (url == m_lanUrl)
        return;
    m_lanUrl = url;
    emit changed();
}

void BrainChoice::setLanModel(const QString& model)
{
    if (model == m_lanModel)
        return;
    m_lanModel = model;
    emit changed();
}

QString BrainChoice::selectedModelName() const { return selected().value("displayName").toString(); }

QString BrainChoice::blockText() const
{
    if (m_kind == u"local" && selected().isEmpty())
        return u"Pick a model for this computer."_s;
    if (m_kind == u"lan") {
        const QUrl url(m_lanUrl.trimmed());
        if (!url.isValid() || (url.scheme() != u"http" && url.scheme() != u"https") || url.host().isEmpty())
            return u"Enter the server address, like http://192.168.1.20:11434."_s;
        if (m_lanModel.trimmed().isEmpty())
            return u"Enter the model name, like qwen3:8b."_s;
    }
    return {};
}

QJsonObject BrainChoice::toJson() const
{
    if (m_kind == u"local")
        return {{"kind", "local"}, {"modelId", m_modelId}};
    if (m_kind == u"lan")
        return {{"kind", "lan"}, {"baseUrl", m_lanUrl.trimmed()}, {"model", m_lanModel.trimmed()}};
    return {{"kind", "cloud"}};
}
