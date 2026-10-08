#include "UiLanguage.h"

#include <QCoreApplication>
#include <QEvent>

#include "Language.h"

using namespace Qt::StringLiterals;

UiLanguage::UiLanguage(QObject* parent)
    : QObject(parent)
    , m_code(jarvis::ui::currentLanguage())
{
    QCoreApplication::instance()->installEventFilter(this);
}

bool UiLanguage::eventFilter(QObject* watched, QEvent* event)
{
    if (event->type() == QEvent::LanguageChange && watched == QCoreApplication::instance()) {
        const QString code = jarvis::ui::currentLanguage();
        if (code != m_code) {
            m_code = code;
            emit changed();
        }
    }
    return QObject::eventFilter(watched, event);
}

QString UiLanguage::formatTime(const QDateTime& when, const QString& lang) const
{
    return jarvis::ui::formatDateTime(when, u"HH:mm"_s, jarvis::ui::isSupportedLanguage(lang) ? lang : m_code);
}

QString UiLanguage::formatDate(const QDateTime& when, const QString& lang) const
{
    const QString code = jarvis::ui::isSupportedLanguage(lang) ? lang : m_code;
    return jarvis::ui::formatDateTime(when, code == u"ar" ? u"dddd، d MMMM"_s : u"dddd, d MMMM"_s, code);
}

QString UiLanguage::format(const QDateTime& when, const QString& pattern, const QString& lang) const
{
    return jarvis::ui::formatDateTime(when, pattern, jarvis::ui::isSupportedLanguage(lang) ? lang : m_code);
}
