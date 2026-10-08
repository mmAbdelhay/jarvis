#include "KeyboardLabel.h"

#include <QFile>
#include <QCoreApplication>

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
    if (layout == u"us") return QCoreApplication::translate("KeyboardLabel", "English (US)");
    if (layout == u"gb") return QCoreApplication::translate("KeyboardLabel", "English (UK)");
    if (layout == u"ara") return QCoreApplication::translate("KeyboardLabel", "Arabic");
    if (layout == u"fr") return QCoreApplication::translate("KeyboardLabel", "French");
    if (layout == u"de") return QCoreApplication::translate("KeyboardLabel", "German");
    if (layout == u"es") return QCoreApplication::translate("KeyboardLabel", "Spanish");
    return layout;
}
