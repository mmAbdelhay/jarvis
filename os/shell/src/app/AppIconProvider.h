#pragma once

#include <QQuickImageProvider>

// image://appicon/<percent-encoded Icon= value> (Plan Y §4.1): a theme icon
// name, or an absolute path inside the system/Flatpak icon folders only.
class AppIconProvider : public QQuickImageProvider {
public:
    AppIconProvider();
    QPixmap requestPixmap(const QString& id, QSize* size, const QSize& requestedSize) override;
    static bool allowedIconPath(const QString& path);
};
