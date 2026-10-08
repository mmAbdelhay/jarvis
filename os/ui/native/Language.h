#pragma once

#include <QDateTime>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>

class QTranslator;

namespace jarvis::ui {

// Rafiq M4 contracts §3: the UI speaks "en" (default) or "ar". Nothing else.
bool isSupportedLanguage(const QString& code);
// LANGUAGE ("ar:en", first supported entry) wins over LANG ("ar_EG.UTF-8").
// C, POSIX, empty or unsupported → "en".
QString languageFromEnvironment(const QString& languageVar, const QString& langVar);
QString languageFromEnvironment();
// A full locale ("ar_EG.UTF-8") → the UI language: "ar" for Arabic, else "en".
QString languageForLocale(const QString& locale);
// $JARVIS_I18N_DIR (tests, development), else /usr/share/jarvis/i18n.
QString i18nDirectory();
// What the running app shows: the application property "jarvisLanguage", else "en".
QString currentLanguage();
// Western digits: U+0660–0669 and U+06F0–06F9 → 0–9, U+066B → '.', U+066C → ','.
QString latinDigits(QString text);
// Month and day names in `lang`, digits always Western.
QString formatDateTime(const QDateTime& when, const QString& format, const QString& lang = currentLanguage());

// One per process. setLanguage() loads <i18nDirectory()>/<catalog>_<lang>.qm for
// every catalog, swaps the app's translators, sets the layout direction
// (ar → RightToLeft) and font families, sets the application property
// "jarvisLanguage", sends QEvent::LanguageChange to the application and emits
// languageChanged(). Connect that to QQmlEngine::retranslate().
class LanguageManager : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString language READ language NOTIFY languageChanged)
    Q_PROPERTY(bool rightToLeft READ rightToLeft NOTIFY languageChanged)

public:
    // The LAST catalog is the app's own: Arabic is refused when it is missing.
    explicit LanguageManager(QStringList catalogs, QObject* parent = nullptr);
    ~LanguageManager() override;

    QString language() const { return m_language; }
    bool rightToLeft() const { return m_language == u"ar"; }
    QStringList loadedFiles() const { return m_loadedFiles; }

    Q_INVOKABLE bool setLanguage(const QString& code);

signals:
    void languageChanged(const QString& code);

private:
    void removeTranslators();

    QStringList m_catalogs;
    QString m_language = QStringLiteral("en");
    bool m_applied = false;
    QList<QTranslator*> m_translators;
    QStringList m_loadedFiles;
};

} // namespace jarvis::ui
