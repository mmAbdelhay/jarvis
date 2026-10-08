#pragma once

#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>
#include <functional>

// The login screen's language (Rafiq M4 contracts §3). The greeter runs before
// any session exists, so it follows the system locale and offers a toggle.
// The toggle also determines the locale passed to the session.
class GreeterLanguage : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(QString language READ language NOTIFY changed)
    Q_PROPERTY(QString otherLanguageName READ otherLanguageName NOTIFY changed)

public:
    using Applier = std::function<bool(const QString& code)>;
    GreeterLanguage(Applier applier, QString initial, QObject* parent = nullptr);

    QString language() const { return m_language; }
    // The language the toggle switches to, named in its own script.
    QString otherLanguageName() const;
    Q_INVOKABLE void toggle();

    // System LANG= in localeFile wins (contracts §6); environment is a fallback.
    static QString systemLanguage(const QString& localeFile = QStringLiteral("/etc/default/locale"));

signals:
    void changed();

private:
    Applier m_applier;
    QString m_language;
};
