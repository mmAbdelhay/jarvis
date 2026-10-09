#pragma once

#include <QObject>

class ClassicController;
class QQuickWindow;

// Places the classic windows (Rafiq M4 contracts §2): taskbar at the bottom
// edge (exclusive zone), Apps menu above the taskbar's start corner, the
// Jarvis panel docked at the end edge. "Start" and "end" follow the layout
// direction. Without layer-shell (macOS, --windowed) they are ordinary windows.
class ClassicSurfaces : public QObject {
    Q_OBJECT
public:
    static constexpr int kTaskbarHeight = 48;
    static constexpr int kChatWidth = 420;

    ClassicSurfaces(QQuickWindow* taskbar, QQuickWindow* apps, QQuickWindow* chat, ClassicController* controller,
                    bool layerShell, QObject* parent = nullptr);
    void show();

signals:
    void taskbarShown(); // first frame of the taskbar
    void chatShown();

private:
    void configure();
    void syncApps();
    void syncChat();

    QQuickWindow* m_taskbar;
    QQuickWindow* m_apps;
    QQuickWindow* m_chat;
    ClassicController* m_controller;
    bool m_layerShell;
};
