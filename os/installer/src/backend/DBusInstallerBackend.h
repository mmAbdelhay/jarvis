#pragma once

#include <QDBusConnection>
#include <QDBusMessage>
#include <QVariantList>
#include <functional>

#include "InstallerBackend.h"

// Client of os.jarvis.Installer1 (M2 contracts §1) on the system bus. All
// payloads are JSON strings; Refused errors become refused(key, words).
class DBusInstallerBackend : public InstallerBackend {
    Q_OBJECT
public:
    explicit DBusInstallerBackend(QDBusConnection bus = QDBusConnection::systemBus(), QObject* parent = nullptr);

    void probe() override;
    void plan(const QJsonObject& choices) override;
    void execute(const QString& planId, QByteArray secretsJson) override;
    void cancel() override;

private slots:
    void onProgress(const QString& stepId, int percent, const QString& detail);
    void onModelProgress(int percent, const QString& detail);
    void onFinished(bool ok, const QString& errorStep, const QString& message);

private:
    using ReplyHandler = std::function<void(const QDBusMessage&)>;
    void call(const QString& method, const QVariantList& args, int timeoutMs, ReplyHandler onReply);
    void answerObject(const QString& method, const QDBusMessage& reply, void (InstallerBackend::*signal)(const QJsonObject&));

    QDBusConnection m_bus;
};
