#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QString>

// The installer's only way to the privileged backend (M2 contracts §1). The UI
// never touches disks: it asks for a probe, sends choices for a plan, and
// executes exactly the planId the backend returned. Every call answers later
// through a signal, never inside the call.
class InstallerBackend : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;

    virtual void probe() = 0;                                         // → probed | callFailed("Probe")
    virtual void plan(const QJsonObject& choices) = 0;                // → planned | refused | callFailed("Plan")
    virtual void execute(const QString& planId, QByteArray secretsJson) = 0; // → executeAccepted | callFailed("Execute")
    virtual void cancel() = 0;                                        // only before the first destructive step

signals:
    void probed(const QJsonObject& result);                // ProbeResult
    void planned(const QJsonObject& plan);                 // InstallPlan
    void refused(const QString& key, const QString& message); // key from the contract list, or "" if unknown
    void executeAccepted();
    void callFailed(const QString& method, const QString& message);
    void progress(const QString& stepId, int percent, const QString& detail);
    void modelProgress(int percent, const QString& detail);
    void finished(bool ok, const QString& errorStep, const QString& message);
};
