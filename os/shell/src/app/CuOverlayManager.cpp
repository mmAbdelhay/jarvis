#include "app/CuOverlayManager.h"

#include <QGuiApplication>
#include <QJSValue>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQuickWindow>
#include <QScreen>

#include "app/ShellIdentity.h"
#include "models/CuSessionModel.h"

#ifdef JARVIS_HAVE_LAYERSHELL
#include <LayerShellQt/window.h>
#endif

using namespace Qt::StringLiterals;

CuOverlayManager::CuOverlayManager(QQmlEngine* engine, CuSessionModel* session, bool layerShell, QObject* parent)
    : QObject(parent)
    , m_engine(engine)
    , m_session(session)
    , m_layerShell(layerShell)
{
    QQuickWindow::setDefaultAlphaBuffer(true); // transparent overlay windows
    const QList<QScreen*> screens = QGuiApplication::screens();
    for (QScreen* screen : screens)
        addScreen(screen);
    connect(qGuiApp, &QGuiApplication::screenAdded, this, &CuOverlayManager::addScreen);
    connect(qGuiApp, &QGuiApplication::screenRemoved, this, &CuOverlayManager::removeScreen);
    connect(qGuiApp, &QGuiApplication::primaryScreenChanged, this, &CuOverlayManager::updatePrimary);
    connect(m_session, &CuSessionModel::changed, this, &CuOverlayManager::sync);
    sync();
}

CuOverlayManager::~CuOverlayManager()
{
    qDeleteAll(m_windows);
}

QQuickWindow* CuOverlayManager::primaryWindow() const
{
    return m_windows.value(QGuiApplication::primaryScreen(), nullptr);
}

QRegion CuOverlayManager::inputRegion(const QVariant& rects)
{
    QVariant value = rects;
    if (value.metaType() == QMetaType::fromType<QJSValue>())
        value = value.value<QJSValue>().toVariant();
    QRegion region;
    const QVariantList list = value.toList();
    for (const QVariant& item : list) {
        if (item.metaType() != QMetaType::fromType<QRectF>() && item.metaType() != QMetaType::fromType<QRect>())
            continue;
        const QRectF rect = item.toRectF();
        if (rect.width() <= 0 || rect.height() <= 0)
            continue;
        region += rect.toAlignedRect();
    }
    return region;
}

void CuOverlayManager::addScreen(QScreen* screen)
{
    if (!screen || m_windows.contains(screen))
        return;
    QQmlComponent component(m_engine, u"Jarvis.Shell"_s, u"CuOverlayWindow"_s);
    QObject* object = component.createWithInitialProperties(
        {{u"session"_s, QVariant::fromValue(m_session)}, {u"primary"_s, screen == QGuiApplication::primaryScreen()}});
    auto* window = qobject_cast<QQuickWindow*>(object);
    if (!window) {
        qWarning("jarvis-shell: the computer-use overlay failed to load: %s", qPrintable(component.errorString()));
        delete object;
        return;
    }
    QQmlEngine::setObjectOwnership(window, QQmlEngine::CppOwnership);
    window->setScreen(screen);
    window->setGeometry(screen->geometry());
    connect(screen, &QScreen::geometryChanged, window, [window](const QRect& geometry) { window->setGeometry(geometry); });
#ifdef JARVIS_HAVE_LAYERSHELL
    if (m_layerShell) {
        using LayerWindow = LayerShellQt::Window;
        LayerWindow* layer = LayerWindow::get(window);
        layer->setScope(jarvis::shell::overlayLayerScope());
        layer->setLayer(LayerWindow::LayerOverlay);
        layer->setAnchors(LayerWindow::Anchors(LayerWindow::AnchorTop | LayerWindow::AnchorBottom
                                               | LayerWindow::AnchorLeft | LayerWindow::AnchorRight));
        layer->setExclusiveZone(-1);
        layer->setKeyboardInteractivity(LayerWindow::KeyboardInteractivityNone);
    }
#endif
    const QMetaObject* meta = window->metaObject();
    const int property = meta->indexOfProperty("inputRects");
    if (property >= 0) {
        const QMetaMethod notify = meta->property(property).notifySignal();
        const QMetaMethod slot = metaObject()->method(metaObject()->indexOfSlot("onInputRectsChanged()"));
        connect(window, notify, this, slot);
    }
    m_windows.insert(screen, window);
    updateMask(window);
    if (m_session->visible())
        window->show();
}

void CuOverlayManager::removeScreen(QScreen* screen)
{
    if (QQuickWindow* window = m_windows.take(screen)) {
        window->hide();
        window->deleteLater();
    }
}

void CuOverlayManager::updatePrimary()
{
    for (auto it = m_windows.constBegin(); it != m_windows.constEnd(); ++it) {
        it.value()->setProperty("primary", it.key() == QGuiApplication::primaryScreen());
        updateMask(it.value());
    }
}

void CuOverlayManager::sync()
{
    const bool visible = m_session->visible();
    for (QQuickWindow* window : std::as_const(m_windows)) {
        updateMask(window);
        if (visible && !window->isVisible())
            window->show();
        else if (!visible && window->isVisible())
            window->hide();
    }
}

void CuOverlayManager::onInputRectsChanged()
{
    if (auto* window = qobject_cast<QQuickWindow*>(sender()))
        updateMask(window);
}

void CuOverlayManager::updateMask(QQuickWindow* window)
{
    const QRegion region = inputRegion(window->property("inputRects"));
    // An empty QWindow mask means "no mask": the whole overlay would take
    // every click. Without the pill and panel the window is input-transparent.
    window->setFlag(Qt::WindowTransparentForInput, region.isEmpty());
    window->setMask(region);
}
