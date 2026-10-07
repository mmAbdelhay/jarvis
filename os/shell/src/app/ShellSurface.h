#pragma once

#include <QObject>

class QQuickWindow;

// Puts the shell's window on a wlr-layer-shell surface (LayerShellQt, Linux
// only, guarded by JARVIS_HAVE_LAYERSHELL): fullscreen on the bottom layer so
// app windows open above it; summon() raises it to the top layer.
class ShellSurface : public QObject {
    Q_OBJECT
public:
    // Configures the surface: call before the window is first shown.
    ShellSurface(QQuickWindow* window, bool layerShell, QObject* parent = nullptr);

    bool usesLayerShell() const { return m_layerShell; }
    void show();

public slots:
    void summon();
    void dismiss();

private:
    QQuickWindow* m_window;
    bool m_layerShell;
};
