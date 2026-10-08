#include "LoginModel.h"

#include <QJsonArray>

#include "GreetdClient.h"
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
        m_errorText = u"Couldn't do that: %1"_s.arg(message);
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
        return m_username.isEmpty() ? u"Other user"_s : m_username;
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
    m_errorText.clear();
    emit userChanged();
    emit stateChanged();
}

void LoginModel::useDefaultUser()
{
    if (m_state != u"idle" || m_users.isEmpty())
        return;
    m_otherUser = false;
    m_username = m_users.first().username;
    m_errorText.clear();
    emit userChanged();
    emit stateChanged();
}

void LoginModel::submit(const QString& secret)
{
    if (m_state == u"busy" || m_state == u"starting")
        return;
    if (m_state == u"prompt") {
        m_errorText.clear();
        m_phase = Phase::Answering;
        setState(u"busy"_s);
        m_client->send({{"type", "post_auth_message_response"}, {"response", secret}});
        return;
    }
    if (m_username.trimmed().isEmpty()) {
        m_errorText = u"Type your username."_s;
        emit stateChanged();
        return;
    }
    if (secret.isEmpty())
        return;
    m_errorText.clear();
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
        m_client->send({{"type", "start_session"}, {"cmd", QJsonArray{u"labwc"_s}}, {"env", QJsonArray{}}});
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
            m_promptText = text.isEmpty() ? u"Password"_s : text;
            m_promptSecret = kind == u"secret";
            return setState(u"prompt"_s);
        }
        (kind == u"error" ? m_errorText : m_infoText) = text;
        emit stateChanged();
        m_client->send({{"type", "post_auth_message_response"}}); // acknowledge info/error
        return;
    }
    if (type == u"error") {
        const QString description = response.value("description").toString();
        if (m_phase == Phase::Starting)
            return fail(u"Couldn't start the session: %1"_s.arg(description));
        if (response.value("error_type").toString() == u"auth_error")
            return fail(u"That password didn't work. Try again."_s);
        return fail(u"Couldn't log in: %1"_s.arg(description));
    }
    fail(u"The login service sent something unexpected."_s);
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
    m_errorText = message;
    m_phase = Phase::None;
    ++m_failures;
    emit failuresChanged();
    m_client->reset();
    setState(u"idle"_s);
}
