#include "Brand.h"

#include <QCoreApplication>
#include <QEvent>

#include "Language.h"
#include "OsRelease.h"

Brand::Brand(QObject* parent)
    : QObject(parent)
    , m_distroName(jarvis::ui::localizedDistroName(jarvis::ui::currentLanguage()))
{
    QCoreApplication::instance()->installEventFilter(this);
}

bool Brand::eventFilter(QObject* watched, QEvent* event)
{
    if (event->type() == QEvent::LanguageChange && watched == QCoreApplication::instance()) {
        const QString name = jarvis::ui::localizedDistroName(jarvis::ui::currentLanguage());
        if (name != m_distroName) {
            m_distroName = name;
            emit changed();
        }
    }
    return QObject::eventFilter(watched, event);
}
