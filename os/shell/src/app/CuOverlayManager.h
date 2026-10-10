#pragma once

#include <QHash>
#include <QObject>
#include <QRegion>
#include <QVariant>

class CuSessionModel;
class QQmlEngine;
class QQuickWindow;
class QScreen;

// Rafiq v1.1 design §2.3: the computer-use overlay on every output. One
// CuOverlayWindow per QScreen (added and removed with the screens); on
// Wayland each is a layer-shell surface on the overlay layer with no keyboard
// interactivity. Only the primary output's pill and panel take pointer input
// (QWindow::setMask); every other window, and the primary one without them,
// is Qt::WindowTransparentForInput.
class CuOverlayManager : public QObject {
    Q_OBJECT
public:
    CuOverlayManager(QQmlEngine* engine, CuSessionModel* session, bool layerShell, QObject* parent = nullptr);
    ~CuOverlayManager() override;

    QList<QQuickWindow*> windows() const { return m_windows.values(); }
    QQuickWindow* primaryWindow() const;
    // QML inputRects (a JS array of rects) -> pixel region, rounded outward;
    // empty rects and non-rect values are skipped.
    static QRegion inputRegion(const QVariant& rects);

private slots:
    void onInputRectsChanged();

private:
    void addScreen(QScreen* screen);
    void removeScreen(QScreen* screen);
    void updatePrimary();
    void sync();
    void updateMask(QQuickWindow* window);

    QQmlEngine* m_engine;
    CuSessionModel* m_session;
    bool m_layerShell;
    QHash<QScreen*, QQuickWindow*> m_windows;
};
