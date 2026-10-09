#pragma once

#include <QDateTime>
#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>

// QML view of the app's language (set by jarvis::ui::LanguageManager in the
// app). Formatting takes the language explicitly so a binding written as
// UiLanguage.formatTime(now, UiLanguage.code) re-evaluates on a switch.
class UiLanguage : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
    Q_PROPERTY(QString code READ code NOTIFY changed)
    Q_PROPERTY(bool rightToLeft READ rightToLeft NOTIFY changed)

public:
    explicit UiLanguage(QObject* parent = nullptr);
    QString code() const { return m_code; }
    bool rightToLeft() const { return m_code == u"ar"; }

    Q_INVOKABLE QString formatTime(const QDateTime& when, const QString& lang) const;
    Q_INVOKABLE QString formatDate(const QDateTime& when, const QString& lang) const;
    Q_INVOKABLE QString format(const QDateTime& when, const QString& pattern, const QString& lang) const;

signals:
    void changed();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    QString m_code;
};
