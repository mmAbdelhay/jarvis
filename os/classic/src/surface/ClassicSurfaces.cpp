#include "surface/ClassicSurfaces.h"

#include <QGuiApplication>
#include <QMargins>
#include <QQuickWindow>
#include <QScreen>

#include "ClassicController.h"

#ifdef JARVIS_CLASSIC_HAVE_LAYERSHELL
#include <LayerShellQt/window.h>
#endif

using namespace Qt::StringLiterals;

ClassicSurfaces::ClassicSurfaces(QQuickWindow* taskbar, QQuickWindow* apps, QQuickWindow* chat,
                                 ClassicController* controller, bool layerShell, QObject* parent)
    : QObject(parent)
    , m_taskbar(taskbar)
    , m_apps(apps)
    , m_chat(chat)
    , m_controller(controller)
    , m_layerShell(layerShell)
{
#ifndef JARVIS_CLASSIC_HAVE_LAYERSHELL
    m_layerShell = false;
#endif
    configure();
    connect(qGuiApp, &QGuiApplication::layoutDirectionChanged, this, &ClassicSurfaces::configure);
    connect(m_controller, &ClassicController::appsOpenChanged, this, &ClassicSurfaces::syncApps);
    connect(m_controller, &ClassicController::chatOpenChanged, this, &ClassicSurfaces::syncChat);
    connect(m_taskbar, &QQuickWindow::frameSwapped, this, &ClassicSurfaces::taskbarShown, Qt::SingleShotConnection);
}

void ClassicSurfaces::configure()
{
    const bool rtl = QGuiApplication::layoutDirection() == Qt::RightToLeft;
#ifdef JARVIS_CLASSIC_HAVE_LAYERSHELL
    if (m_layerShell) {
        using LW = LayerShellQt::Window;
        LW* bar = LW::get(m_taskbar);
        bar->setScope(u"jarvis-classic-taskbar"_s);
        bar->setLayer(LW::LayerTop);
        bar->setAnchors(LW::Anchors(LW::AnchorBottom | LW::AnchorLeft | LW::AnchorRight));
        bar->setExclusiveZone(kTaskbarHeight);
        bar->setKeyboardInteractivity(LW::KeyboardInteractivityNone);

        LW* apps = LW::get(m_apps);
        apps->setScope(u"jarvis-classic-apps"_s);
        apps->setLayer(LW::LayerTop);
        apps->setAnchors(LW::Anchors(LW::AnchorBottom | (rtl ? LW::AnchorRight : LW::AnchorLeft)));
        apps->setMargins(QMargins(8, 0, 8, 8));
        apps->setExclusiveZone(0);
        apps->setKeyboardInteractivity(LW::KeyboardInteractivityExclusive);

        LW* chat = LW::get(m_chat);
        chat->setScope(u"jarvis-classic-chat"_s);
        chat->setLayer(LW::LayerTop);
        chat->setAnchors(LW::Anchors(LW::AnchorTop | LW::AnchorBottom | (rtl ? LW::AnchorLeft : LW::AnchorRight)));
        chat->setExclusiveZone(kChatWidth);
        chat->setKeyboardInteractivity(LW::KeyboardInteractivityOnDemand);
        return;
    }
#endif
    Q_UNUSED(rtl);
    const QRect area = m_taskbar->screen() ? m_taskbar->screen()->availableGeometry() : QRect(0, 0, 1280, 800);
    m_taskbar->setGeometry(area.x(), area.bottom() - kTaskbarHeight + 1, area.width(), kTaskbarHeight);
    m_apps->resize(360, 480);
    m_chat->resize(kChatWidth, area.height() - kTaskbarHeight);
}

void ClassicSurfaces::show()
{
    m_taskbar->show();
    syncApps();
    syncChat();
}

void ClassicSurfaces::syncApps()
{
    if (!m_controller->appsOpen()) {
        m_apps->hide();
        return;
    }
    m_apps->show();
    m_apps->requestActivate();
    QMetaObject::invokeMethod(m_apps, "focusSearch");
}

void ClassicSurfaces::syncChat()
{
    if (!m_controller->chatOpen()) {
        m_chat->hide();
        return;
    }
    m_chat->show();
    m_chat->requestActivate();
    QMetaObject::invokeMethod(m_chat, "focusComposer");
    emit chatShown();
}
