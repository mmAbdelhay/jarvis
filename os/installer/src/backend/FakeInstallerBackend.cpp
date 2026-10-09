#include "FakeInstallerBackend.h"

#include <QFile>
#include <QJsonDocument>
#include <QTimer>
#include <utility>

using namespace Qt::StringLiterals;

FakeInstallerBackend::FakeInstallerBackend(QObject* parent)
    : InstallerBackend(parent)
{
}

FakeInstallerBackend* FakeInstallerBackend::fromFile(const QString& path, QObject* parent)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return nullptr;
    const QJsonDocument doc = QJsonDocument::fromJson(file.readAll());
    if (!doc.isObject())
        return nullptr;
    const QJsonObject script = doc.object();
    auto* backend = new FakeInstallerBackend(parent);
    backend->probeResult = script.value("probe").toObject();
    backend->planTemplate = script.value("plan").toObject();
    backend->playback = script.value("playback").toArray();
    backend->playbackIntervalMs = script.value("intervalMs").toInt(400);
    backend->autoPlay = true;
    return backend;
}

bool FakeInstallerBackend::takeFailure(const QString& method)
{
    if (failNext != method)
        return false;
    failNext.clear();
    QTimer::singleShot(0, this, [this, method] { emit callFailed(method, u"The fake backend was told to fail."_s); });
    return true;
}

void FakeInstallerBackend::probe()
{
    calls.append(u"Probe"_s);
    if (takeFailure(u"Probe"_s))
        return;
    QTimer::singleShot(0, this, [this] { emit probed(probeResult); });
}

void FakeInstallerBackend::plan(const QJsonObject& choicesIn)
{
    calls.append(u"Plan"_s);
    choices.append(choicesIn);
    if (takeFailure(u"Plan"_s))
        return;
    if (!refuseKey.isEmpty()) {
        const QString key = std::exchange(refuseKey, QString());
        const QString message = std::exchange(refuseMessage, QString());
        QTimer::singleShot(0, this, [this, key, message] { emit refused(key, message); });
        return;
    }
    m_lastPlanId = u"fake-plan-%1"_s.arg(++m_plans);
    QJsonObject answer = planTemplate;
    answer.insert("planId", m_lastPlanId);
    QTimer::singleShot(0, this, [this, answer] { emit planned(answer); });
}

void FakeInstallerBackend::execute(const QString& planId, QByteArray secretsJson)
{
    calls.append(u"Execute"_s);
    executedPlanIds.append(planId);
    secrets.append(secretsJson);
    secretsJson.fill('\0');
    if (takeFailure(u"Execute"_s))
        return;
    if (planId.isEmpty() || planId != m_lastPlanId) {
        QTimer::singleShot(0, this, [this] { emit callFailed(u"Execute"_s, u"Unknown plan."_s); });
        return;
    }
    QTimer::singleShot(0, this, [this] {
        emit executeAccepted();
        if (autoPlay)
            play(0);
    });
}

void FakeInstallerBackend::cancel()
{
    calls.append(u"Cancel"_s);
}

void FakeInstallerBackend::play(qsizetype index)
{
    if (index >= playback.size())
        return;
    const QJsonObject event = playback.at(index).toObject();
    if (event.contains("progress")) {
        const QJsonArray a = event.value("progress").toArray();
        emit progress(a.at(0).toString(), a.at(1).toInt(), a.at(2).toString());
    } else if (event.contains("model")) {
        const QJsonArray a = event.value("model").toArray();
        emit modelProgress(a.at(0).toInt(), a.at(1).toString());
    } else if (event.contains("finished")) {
        const QJsonArray a = event.value("finished").toArray();
        emit finished(a.at(0).toBool(), a.at(1).toString(), a.at(2).toString());
    }
    QTimer::singleShot(playbackIntervalMs, this, [this, index] { play(index + 1); });
}
