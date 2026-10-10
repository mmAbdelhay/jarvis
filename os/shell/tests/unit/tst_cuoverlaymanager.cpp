#include <QGuiApplication>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QtQml/qqmlextensionplugin.h>
#include <QtTest>

#include "app/CuOverlayManager.h"
#include "app/ShellIdentity.h"
#include "models/CuSessionModel.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

using namespace Qt::StringLiterals;

namespace {
QJsonObject running()
{
    return {{"active", true}, {"sessionId", "s1"}, {"goal", "Export beach.xcf as PNG"}, {"apps", QJsonArray{"GIMP"}},
            {"step", 1}, {"maxSteps", 50},
            {"steps", QJsonArray{QJsonObject{{"title", "Open the File menu"}, {"status", "running"}}}},
            {"paused", QJsonValue::Null}};
}

QRect sceneRect(QQuickItem* item)
{
    return item->mapRectToScene(QRectF(0, 0, item->width(), item->height())).toAlignedRect();
}
} // namespace

class TestCuOverlayManager : public QObject {
    Q_OBJECT
    QQmlEngine* m_engine = nullptr;

private slots:
    void init()
    {
        m_engine = new QQmlEngine(this);
        m_engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
    }
    void cleanup() { delete m_engine; }

    void identityIsPinned()
    {
        jarvis::shell::applyShellIdentity();
        QCOMPARE(QGuiApplication::desktopFileName(), u"jarvis-shell"_s);
        QCOMPARE(jarvis::shell::shellAppId(), u"jarvis-shell"_s);
        QCOMPARE(jarvis::shell::shellLayerScope(), u"jarvis-shell"_s);
        QCOMPARE(jarvis::shell::overlayLayerScope(), u"jarvis-cu-overlay"_s);
    }

    void oneHiddenWindowPerScreen()
    {
        CuSessionModel session;
        CuOverlayManager overlay(m_engine, &session, false);
        QCOMPARE(overlay.windows().size(), QGuiApplication::screens().size());
        for (QQuickWindow* w : overlay.windows()) {
            QVERIFY(!w->isVisible());
            QVERIFY(w->flags() & Qt::WindowTransparentForInput);
            QVERIFY(w->flags() & Qt::WindowDoesNotAcceptFocus);
        }
        QVERIFY(overlay.primaryWindow());
        QVERIFY(overlay.primaryWindow()->property("primary").toBool());
        QCOMPARE(overlay.primaryWindow()->screen(), QGuiApplication::primaryScreen());
        QCOMPARE(overlay.primaryWindow()->geometry(), QGuiApplication::primaryScreen()->geometry());
    }

    void showsWhileActiveAndHidesAfter()
    {
        CuSessionModel session;
        CuOverlayManager overlay(m_engine, &session, false);
        session.applyState(running());
        for (QQuickWindow* w : overlay.windows())
            QTRY_VERIFY(w->isVisible());
        session.connectionClosed(); // still visible while the connection is lost
        for (QQuickWindow* w : overlay.windows())
            QVERIFY(w->isVisible());
        session.applyState(QJsonObject{{"active", false}});
        for (QQuickWindow* w : overlay.windows())
            QTRY_VERIFY(!w->isVisible());
    }

    void inputRegionIsOnlyThePillAndThePanel()
    {
        CuSessionModel session;
        CuOverlayManager overlay(m_engine, &session, false);
        session.applyState(running());
        QQuickWindow* w = overlay.primaryWindow();
        QTRY_VERIFY(w->isExposed());
        auto* pill = w->findChild<QQuickItem*>(u"cuPill"_s);
        auto* panel = w->findChild<QQuickItem*>(u"cuPanel"_s);
        QVERIFY(pill && panel);
        QTRY_VERIFY(pill->width() > 0 && panel->height() > 0);
        const QRegion expected = QRegion(sceneRect(pill)) + QRegion(sceneRect(panel));
        QTRY_COMPARE(w->mask(), expected);
        QVERIFY(!(w->flags() & Qt::WindowTransparentForInput));
        QVERIFY(!w->mask().contains(QPoint(2, 2)));                          // the border
        QVERIFY(!w->mask().contains(QPoint(w->width() / 2, w->height() - 40))); // the app below
        for (QQuickWindow* other : overlay.windows())
            if (other != w)
                QVERIFY(other->flags() & Qt::WindowTransparentForInput);

        session.applyState(QJsonObject{{"active", false}});
        QTRY_VERIFY(w->flags() & Qt::WindowTransparentForInput);
        QVERIFY(w->mask().isEmpty());
    }

    void inputRegionRoundsOutwardAndSkipsJunk()
    {
        const QVariantList rects{QRectF(10.4, 10.6, 20, 20), QRectF(0, 0, 0, 30), u"x"_s, QRectF(100, 0, 5, 5)};
        QCOMPARE(CuOverlayManager::inputRegion(rects), QRegion(10, 10, 21, 21) + QRegion(100, 0, 5, 5));
        QVERIFY(CuOverlayManager::inputRegion(QVariant()).isEmpty());
        QVERIFY(CuOverlayManager::inputRegion(QVariantList{}).isEmpty());
    }
};

QTEST_MAIN(TestCuOverlayManager)
#include "tst_cuoverlaymanager.moc"
