#pragma once

#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QtQml/qqmlregistration.h>

#include "UserList.h"

class GreetdClient;
class PowerActions;

// The login conversation with greetd (contracts §8): create_session →
// auth_message loop → start_session with the chosen Exec argv and LANG. The typed
// password is sent once and wiped; any error cancels the session so the next
// try starts clean. sessionStarted() means: exit now, greetd starts the selected session.
class LoginModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(QString username READ username WRITE setUsername NOTIFY userChanged)
    Q_PROPERTY(QString displayName READ displayName NOTIFY userChanged)
    Q_PROPERTY(QString initial READ initial NOTIFY userChanged)
    Q_PROPERTY(bool otherUser READ otherUser NOTIFY userChanged)
    Q_PROPERTY(bool canSwitchUser READ canSwitchUser NOTIFY userChanged)
    Q_PROPERTY(QString displayNameOfDefault READ displayNameOfDefault CONSTANT)
    Q_PROPERTY(QString state READ state NOTIFY stateChanged)
    Q_PROPERTY(QString promptText READ promptText NOTIFY stateChanged)
    Q_PROPERTY(bool promptSecret READ promptSecret NOTIFY stateChanged)
    Q_PROPERTY(QString errorText READ errorText NOTIFY stateChanged)
    Q_PROPERTY(QString infoText READ infoText NOTIFY stateChanged)
    Q_PROPERTY(bool powerAvailable READ powerAvailable CONSTANT)
    Q_PROPERTY(int failures READ failures NOTIFY failuresChanged)

public:
    LoginModel(GreetdClient* client, PowerActions* power, QList<UserEntry> users, QObject* parent = nullptr);
    ~LoginModel() override;

    QString username() const { return m_username; }
    void setUsername(const QString& name);
    QString displayName() const;
    QString initial() const;
    bool otherUser() const { return m_otherUser; }
    bool canSwitchUser() const { return m_otherUser && !m_users.isEmpty(); }
    QString displayNameOfDefault() const { return m_users.isEmpty() ? QString() : m_users.first().displayName; }
    QString state() const { return m_state; }
    QString promptText() const { return m_state == u"prompt" && !m_promptText.isEmpty() ? m_promptText : tr("Password"); }
    bool promptSecret() const { return m_state == u"prompt" ? m_promptSecret : true; }
    QString errorText() const { return m_errorText; }
    QString infoText() const { return m_infoText; }
    bool powerAvailable() const;
    int failures() const { return m_failures; }

    void setSessionExec(const QString& exec);
    // Only an explicitly chosen unavailable session blocks login.
    void setSessionFile(const QString& path, bool explicitChoice);

public slots:
    void retranslate();

public:
    Q_INVOKABLE void submit(const QString& secret);
    Q_INVOKABLE void useOtherUser();
    Q_INVOKABLE void useDefaultUser();
    Q_INVOKABLE void powerOff();
    Q_INVOKABLE void reboot();

signals:
    void userChanged();
    void stateChanged();
    void failuresChanged();
    void sessionStarted();

private:
    enum class Phase { None, Creating, Answering, Starting, Cancelling };
    QString translatedError(const char* source, const QString& argument = {});
    void clearError();
    void onResponse(const QJsonObject& response);
    void onFailed(const QString& message);
    void fail(const QString& message);
    void setState(const QString& state);
    void wipePending();

    GreetdClient* m_client;
    PowerActions* m_power;
    QList<UserEntry> m_users;
    QStringList m_sessionCommand;
    QString m_username;
    bool m_otherUser = false;
    QString m_state = QStringLiteral("idle");
    Phase m_phase = Phase::None;
    QString m_pending;
    bool m_hasPending = false;
    QString m_promptText;
    bool m_promptSecret = true;
    const char* m_errorSource = nullptr;
    const char* m_errorContext = "LoginModel";
    QString m_errorArgument;
    QString m_errorText, m_infoText;
    int m_failures = 0;
};
