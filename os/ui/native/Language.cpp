#include "Language.h"

#include <QCoreApplication>
#include <QEvent>
#include <QFont>
#include <QGuiApplication>
#include <QLocale>
#include <QTranslator>

using namespace Qt::StringLiterals;

namespace jarvis::ui {

namespace {
// "ar_EG.UTF-8@euro" → "ar"; stops at the first non-ASCII-letter.
QString prefixOf(QStringView value)
{
    qsizetype end = 0;
    while (end < value.size() && value[end].unicode() < 128 && value[end].isLetter())
        ++end;
    if (end < value.size() && end > 0 && value[end] != u'_' && value[end] != u'.' && value[end] != u'@')
        return {}; // "ar‮" and similar are not a language
    return value.left(end).toString();
}
} // namespace

bool isSupportedLanguage(const QString& code)
{
    return code == u"en" || code == u"ar";
}

QString languageFromEnvironment(const QString& languageVar, const QString& langVar)
{
    // Unlike gettext, LANGUAGE counts even under LANG=C: greetd and cage
    // sessions often run with C.UTF-8 and only LANGUAGE set.
    for (const QString& entry : languageVar.split(u':', Qt::SkipEmptyParts)) {
        const QString code = prefixOf(entry);
        if (isSupportedLanguage(code))
            return code;
    }
    const QString lang = prefixOf(langVar);
    return isSupportedLanguage(lang) ? lang : u"en"_s;
}

QString languageFromEnvironment()
{
    return languageFromEnvironment(qEnvironmentVariable("LANGUAGE"), qEnvironmentVariable("LANG"));
}

QString languageForLocale(const QString& locale)
{
    return prefixOf(locale) == u"ar" ? u"ar"_s : u"en"_s;
}

QString i18nDirectory()
{
    const QString dir = qEnvironmentVariable("JARVIS_I18N_DIR");
    return dir.isEmpty() ? u"/usr/share/jarvis/i18n"_s : dir;
}

QString currentLanguage()
{
    QCoreApplication* app = QCoreApplication::instance();
    const QString code = app ? app->property("jarvisLanguage").toString() : QString();
    return isSupportedLanguage(code) ? code : u"en"_s;
}

QString latinDigits(QString text)
{
    for (QChar& c : text) {
        const char16_t u = c.unicode();
        if (u >= 0x0660 && u <= 0x0669)
            c = QChar(char16_t(u'0' + (u - 0x0660)));
        else if (u >= 0x06F0 && u <= 0x06F9)
            c = QChar(char16_t(u'0' + (u - 0x06F0)));
        else if (u == 0x066B)
            c = u'.';
        else if (u == 0x066C)
            c = u',';
    }
    return text;
}

QString formatDateTime(const QDateTime& when, const QString& format, const QString& lang)
{
    const QLocale locale = lang == u"ar" ? QLocale(QLocale::Arabic, QLocale::Egypt)
                                         : QLocale(QLocale::English, QLocale::UnitedKingdom);
    return latinDigits(locale.toString(when, format));
}

LanguageManager::LanguageManager(QStringList catalogs, QObject* parent)
    : QObject(parent)
    , m_catalogs(std::move(catalogs))
{
}

LanguageManager::~LanguageManager()
{
    removeTranslators();
}

void LanguageManager::removeTranslators()
{
    for (QTranslator* translator : std::as_const(m_translators)) {
        QCoreApplication::removeTranslator(translator);
        delete translator;
    }
    m_translators.clear();
    m_loadedFiles.clear();
}

bool LanguageManager::setLanguage(const QString& code)
{
    if (!isSupportedLanguage(code))
        return false;
    if (m_applied && code == m_language)
        return true;

    QList<QTranslator*> fresh;
    QStringList files;
    bool ownLoaded = false;
    for (qsizetype i = 0; i < m_catalogs.size(); ++i) {
        const QString file = i18nDirectory() + u'/' + m_catalogs.at(i) + u'_' + code + u".qm"_s;
        auto* translator = new QTranslator(this);
        if (translator->load(file)) {
            fresh.append(translator);
            files.append(file);
            ownLoaded = ownLoaded || i == m_catalogs.size() - 1;
        } else {
            delete translator;
            if (code != u"en")
                qWarning("jarvis: missing translation catalog %s", qPrintable(file));
        }
    }
    if (code != u"en" && !ownLoaded) {
        qDeleteAll(fresh); // English stays: never show English text mirrored
        return false;
    }

    removeTranslators();
    QCoreApplication::instance()->setProperty("jarvisLanguage", code);
    for (QTranslator* translator : std::as_const(fresh))
        QCoreApplication::installTranslator(translator);
    m_translators = fresh;
    m_loadedFiles = files;
    m_language = code;
    m_applied = true;

    if (qobject_cast<QGuiApplication*>(QCoreApplication::instance())) {
        const bool rtl = code == u"ar";
        QGuiApplication::setLayoutDirection(rtl ? Qt::RightToLeft : Qt::LeftToRight);
        QFont font = QGuiApplication::font();
        // Contracts §3 fonts: IBM Plex Sans Arabic if packaged, else Noto Sans Arabic.
        font.setFamilies(rtl ? QStringList{u"IBM Plex Sans Arabic"_s, u"Noto Sans Arabic"_s, u"IBM Plex Sans"_s}
                             : QStringList{u"IBM Plex Sans"_s});
        QGuiApplication::setFont(font);
    }
    QEvent change(QEvent::LanguageChange);
    QCoreApplication::sendEvent(QCoreApplication::instance(), &change);
    emit languageChanged(code);
    return true;
}

} // namespace jarvis::ui
