#include "LocaleChoice.h"

#include <QCoreApplication>
#include <QTimeZone>
#include <algorithm>
#include <QVariantMap>

using namespace Qt::StringLiterals;

namespace {
struct Language {
    QStringView locale;
    QStringView name;
    QStringView keyboard;
};
constexpr Language kLanguages[] = {
    {u"en_US.UTF-8", u"English", u"us"},
    {u"ar_EG.UTF-8", u"العربية", u"ara"},
    {u"fr_FR.UTF-8", u"Français", u"fr"},
    {u"de_DE.UTF-8", u"Deutsch", u"de"},
    {u"es_ES.UTF-8", u"Español", u"es"},
};
struct Keyboard {
    QStringView layout;
    const char* name;
};
constexpr Keyboard kKeyboards[] = {
    {u"us", QT_TRANSLATE_NOOP("LocaleChoice", "English (US)")}, {u"gb", QT_TRANSLATE_NOOP("LocaleChoice", "English (UK)")},
    {u"ara", QT_TRANSLATE_NOOP("LocaleChoice", "Arabic")},      {u"fr", QT_TRANSLATE_NOOP("LocaleChoice", "French")},
    {u"de", QT_TRANSLATE_NOOP("LocaleChoice", "German")},       {u"es", QT_TRANSLATE_NOOP("LocaleChoice", "Spanish")},
};

QVariantMap option(const QString& value, const QString& text)
{
    return {{u"value"_s, value}, {u"text"_s, text}};
}
QString keyboardFor(const QString& locale)
{
    for (const Language& l : kLanguages)
        if (l.locale == locale)
            return l.keyboard.toString();
    return u"us"_s;
}
QString timezoneFor(const QString& layout)
{
    if (layout == u"ara") return u"Africa/Cairo"_s;
    if (layout == u"gb") return u"Europe/London"_s;
    if (layout == u"fr") return u"Europe/Paris"_s;
    if (layout == u"de") return u"Europe/Berlin"_s;
    if (layout == u"es") return u"Europe/Madrid"_s;
    return u"America/New_York"_s;
}
} // namespace

LocaleChoice::LocaleChoice(const QString& systemLocale, const QByteArray& systemTimezone, QObject* parent)
    : QObject(parent)
{
    for (const QByteArray& id : QTimeZone::availableTimeZoneIds()) {
        const QString name = QString::fromLatin1(id);
        if (name.contains(u'/') && !name.startsWith(u"Etc/"_s) && !name.startsWith(u"SystemV/"_s))
            m_timezoneIds.append(name);
    }
    m_timezoneIds.sort();
    m_timezoneIds.removeDuplicates();
    m_timezoneIds.append(u"UTC"_s);
    for (const QString& id : std::as_const(m_timezoneIds))
        m_timezones.append(option(id, id));

    m_language = u"en_US.UTF-8"_s;
    const QString prefix = systemLocale.section(u'_', 0, 0) + u'_';
    for (const Language& l : kLanguages)
        if (prefix.size() > 1 && l.locale.startsWith(prefix)) {
            m_language = l.locale.toString();
            break;
        }
    m_keyboard = keyboardFor(m_language);
    const QString zone = QString::fromLatin1(systemTimezone);
    m_timezone = m_timezoneIds.contains(zone) ? zone : u"UTC"_s;
}

QVariantList LocaleChoice::languages() const
{
    QVariantList out;
    for (const Language& l : kLanguages)
        out.append(option(l.locale.toString(), l.name.toString()));
    return out;
}

QVariantList LocaleChoice::keyboards() const
{
    QVariantList out;
    for (const Keyboard& k : kKeyboards)
        out.append(option(k.layout.toString(), QCoreApplication::translate("LocaleChoice", k.name)));
    return out;
}

void LocaleChoice::setLanguage(const QString& locale)
{
    const bool known = std::any_of(std::begin(kLanguages), std::end(kLanguages), [&](const Language& l) { return l.locale == locale; });
    if (!known || locale == m_language)
        return;
    m_language = locale;
    if (!m_keyboardChosen)
        m_keyboard = keyboardFor(locale);
    if (!m_timezoneChosen)
        m_timezone = timezoneFor(m_keyboard);
    emit changed();
}

void LocaleChoice::setKeyboard(const QString& layout)
{
    const bool known = std::any_of(std::begin(kKeyboards), std::end(kKeyboards), [&](const Keyboard& k) { return k.layout == layout; });
    if (!known)
        return;
    m_keyboardChosen = true;
    if (layout == m_keyboard)
        return;
    m_keyboard = layout;
    if (!m_timezoneChosen)
        m_timezone = timezoneFor(layout);
    emit changed();
}

void LocaleChoice::setTypingKeyboard(const QString& layout)
{
    if (layout == m_typingKeyboard)
        return;
    m_typingKeyboard = layout;
    emit changed();
}

QString LocaleChoice::keyboardName(const QString& layout) const
{
    for (const Keyboard& k : kKeyboards)
        if (k.layout == layout)
            return QCoreApplication::translate("LocaleChoice", k.name);
    return layout;
}

void LocaleChoice::setTimezone(const QString& zone)
{
    if (!m_timezoneIds.contains(zone))
        return;
    m_timezoneChosen = true;
    if (zone == m_timezone)
        return;
    m_timezone = zone;
    emit changed();
}

void LocaleChoice::applyProbe(const QJsonObject& probe)
{
    const QString geo = probe.value("geoTimezone").toString();
    if (m_timezoneChosen || !m_timezoneIds.contains(geo) || geo == m_timezone)
        return;
    m_timezone = geo;
    emit changed();
}
