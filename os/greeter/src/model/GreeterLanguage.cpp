#include "GreeterLanguage.h"

#include <QFile>

#include "Language.h"

using namespace Qt::StringLiterals;

GreeterLanguage::GreeterLanguage(Applier applier, QString initial, QObject* parent)
    : QObject(parent)
    , m_applier(std::move(applier))
    , m_language(jarvis::ui::isSupportedLanguage(initial) ? initial : u"en"_s)
{
}

QString GreeterLanguage::otherLanguageName() const
{
    return m_language == u"ar" ? u"English"_s : u"العربية"_s; // i18n: ignore
}

void GreeterLanguage::toggle()
{
    const QString next = m_language == u"ar" ? u"en"_s : u"ar"_s;
    if (m_applier && !m_applier(next))
        return;
    m_language = next;
    emit changed();
}

QString GreeterLanguage::systemLanguage(const QString& localeFile)
{
    QFile file(localeFile);
    if (file.open(QIODevice::ReadOnly)) {
        for (const QByteArray& raw : file.readAll().split('\n')) {
            const QString line = QString::fromUtf8(raw).trimmed();
            if (!line.startsWith(u"LANG="_s))
                continue;
            QString value = line.mid(5).trimmed();
            if (value.size() >= 2 && value.startsWith(u'"') && value.endsWith(u'"'))
                value = value.mid(1, value.size() - 2);
            return jarvis::ui::languageForLocale(value);
        }
    }
    return jarvis::ui::languageFromEnvironment();
}
