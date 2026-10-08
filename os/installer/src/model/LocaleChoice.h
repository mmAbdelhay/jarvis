#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>

// Welcome step (design: Installer Welcome): language, keyboard, time zone.
// The keyboard follows the language until the person picks one; the time zone
// is guessed locally; an explicitly requested ProbeResult.geoTimezone may
// update it unless the person picked one. This model never contacts a service.
class LocaleChoice : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by InstallerModel")
    Q_PROPERTY(QVariantList languages READ languages CONSTANT)
    Q_PROPERTY(QVariantList keyboards READ keyboards CONSTANT)
    Q_PROPERTY(QVariantList timezones READ timezones CONSTANT)
    Q_PROPERTY(QString language READ language WRITE setLanguage NOTIFY changed)
    Q_PROPERTY(QString keyboard READ keyboard WRITE setKeyboard NOTIFY changed)
    Q_PROPERTY(QString timezone READ timezone WRITE setTimezone NOTIFY changed)
    // The layout the live session types with right now ("us" until
    // LiveKeyboard applied the chosen one; contracts §11.5).
    Q_PROPERTY(QString typingKeyboard READ typingKeyboard NOTIFY changed)
    Q_PROPERTY(bool typingMatches READ typingMatches NOTIFY changed)

public:
    LocaleChoice(const QString& systemLocale, const QByteArray& systemTimezone, QObject* parent = nullptr);

    QVariantList languages() const;
    QVariantList keyboards() const;
    QVariantList timezones() const { return m_timezones; }
    QString language() const { return m_language; }
    QString keyboard() const { return m_keyboard; }
    QString timezone() const { return m_timezone; }
    QString typingKeyboard() const { return m_typingKeyboard; }
    bool typingMatches() const { return m_typingKeyboard == m_keyboard; }
    void setTypingKeyboard(const QString& layout);
    Q_INVOKABLE QString keyboardName(const QString& layout) const;
    void setLanguage(const QString& locale);
    void setKeyboard(const QString& layout);
    void setTimezone(const QString& zone);

    void applyProbe(const QJsonObject& probe);

signals:
    void changed();

private:
    QStringList m_timezoneIds;
    QVariantList m_timezones;
    QString m_language, m_keyboard, m_timezone;
    QString m_typingKeyboard = QStringLiteral("us");
    bool m_keyboardChosen = false;
    bool m_timezoneChosen = false;
};
