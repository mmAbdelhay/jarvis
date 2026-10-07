#include "app/ShellSurface.h"

#include <QQuickWindow>

#ifdef JARVIS_HAVE_LAYERSHELL
#include <LayerShellQt/window.h>
#endif

using namespace Qt::StringLiterals;

ShellSurface::ShellSurface(QQuickWindow* window, bool layerShell, QObject* parent)
    : QObject(parent)
    , m_window(window)
    , m_layerShell(layerShell)
{
#ifdef JARVIS_HAVE_LAYERSHELL
    if (m_layerShell) {
        using LayerWindow = LayerShellQt::Window;
        LayerWindow* layer = LayerWindow::get(m_window);
        layer->setScope(u"jarvis-shell"_s);
        layer->setLayer(LayerWindow::LayerBottom);
        layer->setAnchors(LayerWindow::Anchors(LayerWindow::AnchorTop | LayerWindow::AnchorBottom
                                               | LayerWindow::AnchorLeft | LayerWindow::AnchorRight));
        layer->setExclusiveZone(-1);
        layer->setKeyboardInteractivity(LayerWindow::KeyboardInteractivityOnDemand);
    }
#else
    m_layerShell = false;
#endif
}

void ShellSurface::show()
{
    if (m_layerShell)
        m_window->show();
    else
        m_window->showNormal();
}

void ShellSurface::summon()
{
#ifdef JARVIS_HAVE_LAYERSHELL
    if (m_layerShell)
        LayerShellQt::Window::get(m_window)->setLayer(LayerShellQt::Window::LayerTop);
#endif
    if (!m_layerShell)
        m_window->raise();
    m_window->requestActivate();
}

void ShellSurface::dismiss()
{
#ifdef JARVIS_HAVE_LAYERSHELL
    if (m_layerShell)
        LayerShellQt::Window::get(m_window)->setLayer(LayerShellQt::Window::LayerBottom);
#endif
}
