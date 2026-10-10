#include "app/AppIconProvider.h"

#include <algorithm>
#include <QDir>
#include <QIcon>
#include <QUrl>

using namespace Qt::StringLiterals;

AppIconProvider::AppIconProvider()
    : QQuickImageProvider(QQuickImageProvider::Pixmap)
{
    if (QIcon::themeName().isEmpty())
        QIcon::setThemeName(u"hicolor"_s);
    QIcon::setFallbackThemeName(u"hicolor"_s);
    QIcon::setThemeSearchPaths(QIcon::themeSearchPaths()
                               << u"/var/lib/flatpak/exports/share/icons"_s
                               << QDir::homePath() + u"/.local/share/flatpak/exports/share/icons"_s);
}

bool AppIconProvider::allowedIconPath(const QString& path)
{
    const QString clean = QDir::cleanPath(path);
    if (clean != path && clean + u'/' != path)
        return false; // no "..", no doubled slashes
    static const QStringList suffixes{u".png"_s, u".svg"_s, u".xpm"_s};
    if (!std::any_of(suffixes.cbegin(), suffixes.cend(), [&](const QString& s) { return clean.endsWith(s, Qt::CaseInsensitive); }))
        return false;
    const QStringList roots{u"/usr/share/icons/"_s, u"/usr/share/pixmaps/"_s, u"/var/lib/flatpak/exports/share/icons/"_s,
                            QDir::homePath() + u"/.local/share/flatpak/exports/share/icons/"_s,
                            QDir::homePath() + u"/.local/share/icons/"_s};
    return std::any_of(roots.cbegin(), roots.cend(), [&](const QString& root) { return clean.startsWith(root); });
}

QPixmap AppIconProvider::requestPixmap(const QString& id, QSize* size, const QSize& requestedSize)
{
    const QString name = QUrl::fromPercentEncoding(id.toUtf8());
    const int edge = requestedSize.isValid() ? qMax(requestedSize.width(), requestedSize.height()) : 48;
    QIcon icon;
    if (name.startsWith(u'/')) {
        if (allowedIconPath(name))
            icon = QIcon(name);
    } else if (!name.isEmpty() && !name.contains(u'/')) {
        icon = QIcon::fromTheme(name);
    }
    const QPixmap pixmap = icon.isNull() ? QPixmap() : icon.pixmap(edge, edge);
    if (size)
        *size = pixmap.size();
    return pixmap;
}
