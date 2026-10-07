#include "Brand.h"

#include "OsRelease.h"

Brand::Brand(QObject* parent)
    : QObject(parent)
    , m_distroName(jarvis::ui::distroName())
{
}
