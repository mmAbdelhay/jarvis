#include "KeyboardLabel.h"

#include <QFile>

using namespace Qt::StringLiterals;

namespace {
QString firstLayout(const QString& path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return u"us"_s;
    while (!file.atEnd()) {
        const QString line = QString::fromUtf8(file.readLine()).trimmed();
        if (!line.startsWith(u"XKBLAYOUT="))
            continue;
        QString value = line.mid(10);
        value.remove(u'"');
        const QString first = value.section(u',', 0, 0).trimmed();
        return first.isEmpty() ? u"us"_s : first;
    }
    return u"us"_s;
}
} // namespace

QString keyboardCode(const QString& path)
{
    const QString layout = firstLayout(path);
    if (layout == u"us" || layout == u"gb")
        return u"EN"_s;
    if (layout == u"ara")
        return u"AR"_s;
    return layout.left(2).toUpper();
}

QString keyboardName(const QString& path)
{
    const QString layout = firstLayout(path);
    if (layout == u"us") return u"English (US)"_s;
    if (layout == u"gb") return u"English (UK)"_s;
    if (layout == u"ara") return u"Arabic"_s;
    if (layout == u"fr") return u"French"_s;
    if (layout == u"de") return u"German"_s;
    if (layout == u"es") return u"Spanish"_s;
    return layout;
}
