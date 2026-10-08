#pragma once

#include <QJsonArray>
#include <QList>
#include <QStringList>

#include "InstallerBackend.h"

// In-process stand-in for os.jarvis.Installer1: scripted answers, recorded
// calls. Used by every test and by `jarvis-installer --fake-backend <json>`
// (macOS dev, screenshots). It never runs a command.
class FakeInstallerBackend : public InstallerBackend {
    Q_OBJECT
public:
    explicit FakeInstallerBackend(QObject* parent = nullptr);
    // {"probe": ProbeResult, "plan": InstallPlan, "playback": [...], "intervalMs": n}; nullptr if unreadable.
    static FakeInstallerBackend* fromFile(const QString& path, QObject* parent);

    void probe() override;
    void plan(const QJsonObject& choices) override;
    void execute(const QString& planId, QByteArray secretsJson) override;
    void cancel() override;

    // Script
    QJsonObject probeResult;
    QJsonObject planTemplate;
    QString refuseKey;     // non-empty: the next Plan is refused with refuseKey/refuseMessage
    QString refuseMessage;
    QString failNext;      // "Probe" | "Plan" | "Execute": that call fails once with callFailed
    QJsonArray playback;   // after Execute when autoPlay: {"progress":[id,pct,detail]} | {"model":[pct,detail]} | {"finished":[ok,step,msg]}
    int playbackIntervalMs = 0;
    bool autoPlay = false;

    // Record
    QStringList calls;
    QList<QJsonObject> choices;
    QStringList executedPlanIds;
    QList<QByteArray> secrets;
    QString lastPlanId() const { return m_lastPlanId; }

private:
    bool takeFailure(const QString& method);
    void play(qsizetype index);

    int m_plans = 0;
    QString m_lastPlanId;
};
