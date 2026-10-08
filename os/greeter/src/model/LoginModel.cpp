#include "LoginModel.h"

#include <QJsonArray>
#include <QCoreApplication>

#include "GreetdClient.h"
#include "DesktopEntry.h"
#include "Language.h"
#include "GreeterLanguage.h"
#include "PowerActions.h"

using namespace Qt::StringLiterals;

LoginModel::LoginModel(GreetdClient* client, PowerActions* power, QList<UserEntry> users, QObject* parent)
    : QObject(parent)
    , m_client(client)
    , m_power(power)
    , m_users(std::move(users))
{
    connect(m_client, &GreetdClient::response, this, &LoginModel::onResponse);
    connect(m_client, &GreetdClient::failed, this, &LoginModel::onFailed);
    connect(m_power, &PowerActions::failed, this, [this](const QString& message) {
        m_errorText = translatedError(QT_TR_NOOP("Couldn't do that: %1"), message);
        emit stateChanged();
    });
    if (m_users.isEmpty())
        m_otherUser = true;
    else
        m_username = m_users.first().username;
}

LoginModel::~LoginModel()
{
    wipePending();
}

void LoginModel::setUsername(const QString& name)
{
    if (!m_otherUser || name == m_username)
        return;
    m_username = name;
    emit userChanged();
}

QString LoginModel::displayName() const
{
    if (m_otherUser)
        return m_username.isEmpty() ? tr("Other user") : m_username;
    for (const UserEntry& user : m_users)
        if (user.username == m_username)
            return user.displayName;
    return m_username;
}

QString LoginModel::initial() const
{
    if (m_otherUser && m_username.isEmpty())
        return u"?"_s;
    const QString name = displayName();
    return name.isEmpty() ? u"?"_s : name.left(1).toUpper();
}

bool LoginModel::powerAvailable() const { return m_power->available(); }
void LoginModel::powerOff() { m_power->powerOff(); }
void LoginModel::reboot() { m_power->reboot(); }

void LoginModel::setState(const QString& state)
{
    m_state = state;
    emit stateChanged();
}

void LoginModel::wipePending()
{
    m_pending.fill(QChar(u'\0'));
    m_pending.clear();
    m_hasPending = false;
}

void LoginModel::useOtherUser()
{
    if (m_state != u"idle" || m_otherUser)
        return;
    m_otherUser = true;
    m_username.clear();
    clearError();
    emit userChanged();
    emit stateChanged();
}

void LoginModel::useDefaultUser()
{
    if (m_state != u"idle" || m_users.isEmpty())
        return;
    m_otherUser = false;
    m_username = m_users.first().username;
    clearError();
    emit userChanged();
    emit stateChanged();
}

void LoginModel::submit(const QString& secret)
{
    if (m_state == u"busy" || m_state == u"starting")
        return;
    if (m_state == u"prompt") {
        clearError();
        m_phase = Phase::Answering;
        setState(u"busy"_s);
        m_client->send({{"type", "post_auth_message_response"}, {"response", secret}});
        return;
    }
    if (m_username.trimmed().isEmpty()) {
        m_errorText = translatedError(QT_TR_NOOP("Type your username."));
        emit stateChanged();
        return;
    }
    if (m_sessionCommand.isEmpty()) {
        m_errorText = translatedError(QT_TR_NOOP("The selected session is unavailable."));
        emit stateChanged();
        return;
    }
    if (secret.isEmpty())
        return;
    clearError();
    m_infoText.clear();
    m_pending = secret;
    m_hasPending = true;
    m_phase = Phase::Creating;
    setState(u"busy"_s);
    m_client->send({{"type", "create_session"}, {"username", m_username.trimmed()}});
}

void LoginModel::onResponse(const QJsonObject& response)
{
    const QString type = response.value("type").toString();
    if (m_phase == Phase::Cancelling) {
        m_phase = Phase::None;
        return setState(u"idle"_s);
    }
    if (type == u"success") {
        if (m_phase == Phase::Starting) {
            emit sessionStarted();
            return;
        }
        wipePending();
        m_phase = Phase::Starting;
        setState(u"starting"_s);
        const QString locale = GreeterLanguage::sessionLocale(jarvis::ui::currentLanguage());
        const QJsonArray environment = locale.isEmpty() ? QJsonArray{} : QJsonArray{u"LANG="_s + locale};
        m_client->send({{"type", "start_session"}, {"cmd", QJsonArray::fromStringList(m_sessionCommand)},
                        {"env", environment}});
        return;
    }
    if (type == u"auth_message") {
        const QString kind = response.value("auth_message_type").toString();
        const QString text = response.value("auth_message").toString().trimmed();
        m_phase = Phase::Answering;
        if (kind == u"secret" || kind == u"visible") {
            if (m_hasPending) {
                const QJsonObject answer{{"type", "post_auth_message_response"}, {"response", m_pending}};
                wipePending();
                m_client->send(answer);
                return;
            }
            m_promptText = text;
            m_promptSecret = kind == u"secret";
            return setState(u"prompt"_s);
        }
        if (kind == u"error") clearError();
        (kind == u"error" ? m_errorText : m_infoText) = text;
        emit stateChanged();
        m_client->send({{"type", "post_auth_message_response"}}); // acknowledge info/error
        return;
    }
    if (type == u"error") {
        const QString description = response.value("description").toString();
        if (m_phase == Phase::Starting)
            return fail(translatedError(QT_TR_NOOP("Couldn't start the session: %1"), description));
        if (response.value("error_type").toString() == u"auth_error")
            return fail(translatedError(QT_TR_NOOP("That password didn't work. Try again.")));
        return fail(translatedError(QT_TR_NOOP("Couldn't log in: %1"), description));
    }
    fail(translatedError(QT_TR_NOOP("The login service sent something unexpected.")));
}

void LoginModel::fail(const QString& message)
{
    wipePending();
    m_errorText = message;
    ++m_failures;
    emit failuresChanged();
    m_phase = Phase::Cancelling;
    setState(u"busy"_s);
    m_client->send({{"type", "cancel_session"}});
}

void LoginModel::onFailed(const QString& message)
{
    wipePending();
    clearError();
    for (const char* source : {"The login service isn't running.", "Lost the connection to the login service.", "The login service sent something unreadable."}) {
        if (message == QCoreApplication::translate("GreetdClient", source)) {
            m_errorSource = source;
            m_errorContext = "GreetdClient";
            break;
        }
    }
    m_errorText = message;
    m_phase = Phase::None;
    ++m_failures;
    emit failuresChanged();
    m_client->reset();
    setState(u"idle"_s);
}

void LoginModel::setSessionFile(const QString& path, bool explicitChoice)
{
    m_sessionCommand.clear();
    if (const auto entry = jarvis::ui::parseDesktopEntry(path))
        setSessionExec(entry->exec);
    if (m_sessionCommand.isEmpty() && !explicitChoice)
        m_sessionCommand = QStringList{u"labwc"_s};
}

void LoginModel::setSessionExec(const QString& exec)
{
    m_sessionCommand = jarvis::ui::splitExec(exec).value_or(QStringList{});
}

void LoginModel::retranslate()
{
    if (m_errorSource) {
        m_errorText = QCoreApplication::translate(m_errorContext, m_errorSource);
        if (m_errorText.contains(u"%1")) m_errorText = m_errorText.arg(m_errorArgument);
    }
    emit userChanged();
    emit stateChanged();
}

QString LoginModel::translatedError(const char* source, const QString& argument)
{
    m_errorSource = source;
    m_errorContext = "LoginModel";
    m_errorArgument = argument;
    const QString text = tr(source);
    return text.contains(u"%1") ? text.arg(argument) : text;
}

void LoginModel::clearError()
{
    m_errorSource = nullptr;
    m_errorArgument.clear();
    m_errorText.clear();
}
