#include "DBusInstallerBackend.h"

#include <QDBusPendingCallWatcher>
#include <QJsonDocument>
#include <utility>

#include "InstallRules.h"

using namespace Qt::StringLiterals;

namespace {
const QString kService = u"os.jarvis.Installer1"_s;
const QString kPath = u"/os/jarvis/Installer1"_s;
const QString kInterface = u"os.jarvis.Installer1"_s;
const QString kRefused = u"os.jarvis.Installer1.Error.Refused"_s;
} // namespace

DBusInstallerBackend::DBusInstallerBackend(QDBusConnection bus, QObject* parent)
    : InstallerBackend(parent)
    , m_bus(std::move(bus))
{
    m_bus.connect(kService, kPath, kInterface, u"Progress"_s, this, SLOT(onProgress(QString,int,QString)));
    m_bus.connect(kService, kPath, kInterface, u"ModelProgress"_s, this, SLOT(onModelProgress(int,QString)));
    m_bus.connect(kService, kPath, kInterface, u"Finished"_s, this, SLOT(onFinished(bool,QString,QString)));
}

void DBusInstallerBackend::onProgress(const QString& stepId, int percent, const QString& detail) { emit progress(stepId, percent, detail); }
void DBusInstallerBackend::onModelProgress(int percent, const QString& detail) { emit modelProgress(percent, detail); }
void DBusInstallerBackend::onFinished(bool ok, const QString& errorStep, const QString& message) { emit finished(ok, errorStep, message); }

void DBusInstallerBackend::call(const QString& method, const QVariantList& args, int timeoutMs, ReplyHandler onReply)
{
    QDBusMessage message = QDBusMessage::createMethodCall(kService, kPath, kInterface, method);
    message.setArguments(args);
    auto* watcher = new QDBusPendingCallWatcher(m_bus.asyncCall(message, timeoutMs), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this,
            [this, method, onReply = std::move(onReply)](QDBusPendingCallWatcher* w) {
                w->deleteLater();
                const QDBusMessage reply = w->reply();
                if (reply.type() != QDBusMessage::ErrorMessage)
                    return onReply(reply);
                if (reply.errorName() == kRefused) {
                    const auto [key, words] = jarvis::installer::splitRefusal(reply.errorMessage());
                    emit refused(key, words);
                    return;
                }
                emit callFailed(method, reply.errorMessage().isEmpty() ? reply.errorName() : reply.errorMessage());
            });
}

void DBusInstallerBackend::answerObject(const QString& method, const QDBusMessage& reply,
                                        void (InstallerBackend::*signal)(const QJsonObject&))
{
    const QJsonDocument doc = QJsonDocument::fromJson(reply.arguments().value(0).toString().toUtf8());
    if (!doc.isObject())
        return emit callFailed(method, u"the answer could not be read"_s);
    emit(this->*signal)(doc.object());
}

void DBusInstallerBackend::probe()
{
    call(u"Probe"_s, {}, 120000, [this](const QDBusMessage& r) { answerObject(u"Probe"_s, r, &InstallerBackend::probed); });
}

void DBusInstallerBackend::plan(const QJsonObject& choices)
{
    const QString json = QString::fromUtf8(QJsonDocument(choices).toJson(QJsonDocument::Compact));
    call(u"Plan"_s, {json}, 60000, [this](const QDBusMessage& r) { answerObject(u"Plan"_s, r, &InstallerBackend::planned); });
}

void DBusInstallerBackend::execute(const QString& planId, QByteArray secretsJson)
{
    QString secrets = QString::fromUtf8(secretsJson);
    secretsJson.fill('\0');
    call(u"Execute"_s, {planId, secrets}, 30000, [this](const QDBusMessage&) { emit executeAccepted(); });
    secrets.fill(QChar(u'\0')); // the message is already serialised; this copy is no longer shared
}

void DBusInstallerBackend::cancel()
{
    call(u"Cancel"_s, {}, 10000, [](const QDBusMessage&) {});
}
