#include "AccountChoice.h"

#include <QJsonDocument>

#include "InstallRules.h"

using namespace Qt::StringLiterals;
using namespace jarvis::installer;

namespace {
void wipeString(QString& s)
{
    s.fill(QChar(u'\0'));
    s.clear();
}
} // namespace

AccountChoice::AccountChoice(QObject* parent)
    : QObject(parent)
{
}

AccountChoice::~AccountChoice()
{
    wipe();
}

void AccountChoice::setString(QString& field, const QString& value)
{
    if (field == value)
        return;
    wipeString(field);
    field = value;
    emit changed();
}

void AccountChoice::setFullName(const QString& name)
{
    if (name == m_fullName)
        return;
    m_fullName = name;
    if (!m_usernameEdited) {
        m_username = deriveUsername(name);
        if (!m_hostnameEdited)
            m_hostname = deriveHostname(m_username);
    }
    emit changed();
}

void AccountChoice::setUsername(const QString& name)
{
    if (name == m_username)
        return;
    m_username = name;
    m_usernameEdited = !name.isEmpty(); // cleared: derive from the name again
    if (!m_hostnameEdited)
        m_hostname = deriveHostname(name);
    emit changed();
}

void AccountChoice::setHostname(const QString& name)
{
    if (name == m_hostname)
        return;
    m_hostname = name;
    m_hostnameEdited = !name.isEmpty();
    emit changed();
}

void AccountChoice::setPassword(const QString& value) { setString(m_password, value); }
void AccountChoice::setConfirm(const QString& value) { setString(m_confirm, value); }
void AccountChoice::setDiskPassphrase(const QString& value) { setString(m_diskPassphrase, value); }
void AccountChoice::setDiskConfirm(const QString& value) { setString(m_diskConfirm, value); }

void AccountChoice::setAutologin(bool on)
{
    if (on == m_autologin)
        return;
    m_autologin = on;
    emit changed();
}

void AccountChoice::setEncrypt(bool on)
{
    if (on == m_encrypt)
        return;
    m_encrypt = on;
    emit changed();
}

void AccountChoice::setDiskSameAsPassword(bool same)
{
    if (same == m_diskSame)
        return;
    m_diskSame = same;
    emit changed();
}

QString AccountChoice::usernameProblem() const
{
    return m_username.isEmpty() ? QString() : jarvis::installer::usernameProblem(m_username);
}

QString AccountChoice::hostnameProblem() const
{
    return m_hostname.isEmpty() ? QString() : jarvis::installer::hostnameProblem(m_hostname);
}

QString AccountChoice::passwordStatus() const { return jarvis::installer::passwordStatus(m_password, m_confirm); }
bool AccountChoice::passwordOk() const { return passwordAcceptable(m_password, m_confirm); }
QString AccountChoice::diskStatus() const { return jarvis::installer::passwordStatus(m_diskPassphrase, m_diskConfirm); }
bool AccountChoice::diskOk() const { return !m_encrypt || m_diskSame || passwordAcceptable(m_diskPassphrase, m_diskConfirm); }

QString AccountChoice::blockText() const
{
    if (m_fullName.trimmed().isEmpty())
        return u"Enter your name."_s;
    if (const QString p = jarvis::installer::usernameProblem(m_username); !p.isEmpty())
        return p;
    if (const QString p = jarvis::installer::hostnameProblem(m_hostname); !p.isEmpty())
        return p;
    if (m_password.isEmpty())
        return u"Choose a password."_s;
    if (passwordStrength(m_password) < Strength::Fair)
        return u"Use at least 8 characters for the password."_s;
    if (m_password != m_confirm)
        return u"The passwords don't match."_s;
    if (m_encrypt && !m_diskSame) {
        if (passwordStrength(m_diskPassphrase) < Strength::Fair)
            return u"Use at least 8 characters for the disk passphrase."_s;
        if (m_diskPassphrase != m_diskConfirm)
            return u"The disk passphrases don't match."_s;
    }
    return {};
}

QJsonObject AccountChoice::toJson() const
{
    return {{"fullName", m_fullName.trimmed()}, {"username", m_username}, {"hostname", m_hostname}, {"autologin", m_autologin}};
}

QByteArray AccountChoice::secretsJson() const
{
    const QJsonValue luks = m_encrypt ? QJsonValue(m_diskSame ? m_password : m_diskPassphrase) : QJsonValue(QJsonValue::Null);
    return QJsonDocument(QJsonObject{{"userPassword", m_password}, {"luksPassphrase", luks}}).toJson(QJsonDocument::Compact);
}

void AccountChoice::wipe()
{
    wipeString(m_password);
    wipeString(m_confirm);
    wipeString(m_diskPassphrase);
    wipeString(m_diskConfirm);
    emit changed();
}
