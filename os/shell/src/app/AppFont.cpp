#include "app/AppFont.h"

#include <QFont>
#include <QGuiApplication>

void applyShellFont()
{
    QFont font(QStringLiteral("IBM Plex Sans"));
    font.setStyleHint(QFont::SansSerif);
    font.setPixelSize(15);
    QGuiApplication::setFont(font);
}
