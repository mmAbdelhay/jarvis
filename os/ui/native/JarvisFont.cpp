#include "JarvisFont.h"

#include <QFont>
#include <QGuiApplication>

void jarvis::ui::applyJarvisFont(qreal scale)
{
    QFont font(QStringLiteral("IBM Plex Sans"));
    font.setStyleHint(QFont::SansSerif);
    font.setPixelSize(qRound(15 * scale));
    QGuiApplication::setFont(font);
}
