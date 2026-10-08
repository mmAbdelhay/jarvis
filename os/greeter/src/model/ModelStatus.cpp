#include "ModelStatus.h"

#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <algorithm>

using namespace Qt::StringLiterals;

ModelStatus::ModelStatus(QString statePath, QString catalogPath, QObject* parent)
    : QObject(parent)
    , m_statePath(std::move(statePath))
    , m_catalogPath(std::move(catalogPath))
{
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, this, &ModelStatus::reload);
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, this, &ModelStatus::reload);
    m_poll.setInterval(5000); // watchers miss some renames; the file is tiny
    connect(&m_poll, &QTimer::timeout, this, &ModelStatus::reload);
    m_poll.start();
    reload();
}

QString ModelStatus::defaultStatePath()
{
    const QString env = qEnvironmentVariable("JARVIS_MODEL_STATE");
    return env.isEmpty() ? u"/var/lib/jarvis/model-state.json"_s : env;
}

QString ModelStatus::defaultCatalogPath()
{
    const QString env = qEnvironmentVariable("JARVIS_MODEL_CATALOG");
    return env.isEmpty() ? u"/usr/share/jarvis/models/catalog.json"_s : env;
}

void ModelStatus::watch()
{
    const QString dir = QFileInfo(m_statePath).absolutePath();
    if (!m_watcher.directories().contains(dir) && QFileInfo::exists(dir))
        m_watcher.addPath(dir);
    if (!m_watcher.files().contains(m_statePath) && QFileInfo::exists(m_statePath))
        m_watcher.addPath(m_statePath); // re-added after each atomic rename
}

QString ModelStatus::modelName(const QString& modelId, const QString& tag) const
{
    QFile file(m_catalogPath);
    if (file.open(QIODevice::ReadOnly)) {
        const QJsonArray models = QJsonDocument::fromJson(file.readAll()).object().value("models").toArray();
        for (const QJsonValue& value : models) {
            const QJsonObject m = value.toObject();
            if ((!modelId.isEmpty() && m.value("id").toString() == modelId) || (!tag.isEmpty() && m.value("ollamaTag").toString() == tag))
                return m.value("displayName").toString();
        }
    }
    return tag.isEmpty() ? modelId : tag;
}

void ModelStatus::reload()
{
    watch();
    bool shown = false, ready = false;
    QString text;
    QFile file(m_statePath);
    if (file.open(QIODevice::ReadOnly)) {
        const QJsonDocument doc = QJsonDocument::fromJson(file.read(64 * 1024));
        const QJsonObject s = doc.object();
        const QString state = s.value("state").toString();
        const QString name = modelName(s.value("modelId").toString(), s.value("ollamaTag").toString());
        const int percent = std::clamp(int(s.value("percent").toDouble()), 0, 100);
        if (doc.isObject() && !name.isEmpty()) {
            shown = true;
            if (state == u"ready") {
                ready = true;
                text = tr("Jarvis is ready · %1 loaded").arg(name);
            } else if (state == u"downloading" || state == u"pending") {
                text = tr("Preparing %1 · %2%").arg(name).arg(percent);
            } else if (state == u"failed") {
                text = tr("Jarvis couldn't download %1 yet. It will try again.").arg(name);
            } else {
                shown = false;
            }
        }
    }
    if (shown == m_shown && ready == m_ready && text == m_text)
        return;
    m_shown = shown;
    m_ready = ready;
    m_text = text;
    emit changed();
}

void ModelStatus::retranslate()
{
    reload();
    emit changed();
}
