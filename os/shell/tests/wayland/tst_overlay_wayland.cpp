#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonObject>
#include <QProcess>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtQml/qqmlextensionplugin.h>
#include <QtTest>

#include "app/CuOverlayManager.h"
#include "models/CuSessionModel.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

using namespace Qt::StringLiterals;

namespace {
QJsonObject running()
{
    return {{"active", true}, {"sessionId", "s1"}, {"goal", "Export beach.xcf as PNG"}, {"apps", QJsonArray{"GIMP"}},
            {"step", 2}, {"maxSteps", 50},
            {"steps", QJsonArray{QJsonObject{{"title", "Open the File menu"}, {"status", "done"}},
                                 QJsonObject{{"title", "Choose Export As"}, {"status", "running"}}}},
            {"paused", QJsonValue::Null}};
}

bool isTeal(QRgb p) // Theme.accent #4FD8C4
{
    return qAbs(qRed(p) - 0x4F) <= 12 && qAbs(qGreen(p) - 0xD8) <= 12 && qAbs(qBlue(p) - 0xC4) <= 12;
}

QImage grab(const QString& output, const QString& dir)
{
    const QString path = dir + u"/"_s + output + u".png"_s;
    QProcess grim;
    grim.start(u"grim"_s, {u"-o"_s, output, path});
    if (!grim.waitForFinished(10000) || grim.exitCode() != 0)
        return {};
    return QImage(path);
}

bool run(const QString& program, const QStringList& args)
{
    return QProcess::execute(program, args) == 0;
}

// wlrctl moves the virtual pointer relatively: park it in the layout's
// top-left corner first, then move to the global point and click. labwc needs
// a moment to deliver wl_pointer.enter to the surface under the pointer;
// a click sent in the same instant as the move is lost.
bool clickAt(const QPoint& global)
{
    if (!run(u"wlrctl"_s, {u"pointer"_s, u"move"_s, u"-20000"_s, u"-20000"_s})
        || !run(u"wlrctl"_s, {u"pointer"_s, u"move"_s, QString::number(global.x()), QString::number(global.y())}))
        return false;
    QTest::qWait(300);
    return run(u"wlrctl"_s, {u"pointer"_s, u"click"_s, u"left"_s});
}

const char* kAppQml = "import QtQuick\n"
                      "Window { id: w; property int clicks: 0; color: \"#C0392B\"\n"
                      "  MouseArea { anchors.fill: parent; onClicked: w.clicks++ } }\n";
} // namespace

class TestOverlayWayland : public QObject {
    Q_OBJECT
private slots:
    void initTestCase()
    {
        QVERIFY2(QGuiApplication::platformName().startsWith(u"wayland"_s), "run inside labwc (run-headless-labwc.sh)");
        QTRY_COMPARE_WITH_TIMEOUT(QGuiApplication::screens().size(), 2, 10000);
    }

    void borderOnEveryOutputAndClicksPassThrough()
    {
        QQmlEngine engine;
        engine.addImportPath(QStringLiteral(JARVIS_QML_DIR));
        QQmlComponent appComponent(&engine);
        appComponent.setData(kAppQml, QUrl());
        auto* app = qobject_cast<QQuickWindow*>(appComponent.create());
        QVERIFY2(app, qPrintable(appComponent.errorString()));
        app->setScreen(QGuiApplication::primaryScreen());
        app->showFullScreen();
        QTRY_VERIFY_WITH_TIMEOUT(app->isExposed(), 5000);

        CuSessionModel session;
        CuOverlayManager overlay(&engine, &session, true);
        QSignalSpy stops(&session, &CuSessionModel::stopRequested);
        session.applyState(running());
        for (QQuickWindow* w : overlay.windows())
            QTRY_VERIFY_WITH_TIMEOUT(w->isExposed(), 5000);
        QTest::qWait(500); // a frame on each output

        QTemporaryDir dir;
        for (QScreen* screen : QGuiApplication::screens()) {
            const QImage shot = grab(screen->name(), dir.path());
            QVERIFY2(!shot.isNull(), qPrintable(screen->name()));
            QVERIFY2(isTeal(shot.pixel(1, 1)), qPrintable(screen->name()));
            QVERIFY2(isTeal(shot.pixel(shot.width() - 2, shot.height() - 2)), qPrintable(screen->name()));
            QVERIFY2(!isTeal(shot.pixel(shot.width() / 2, shot.height() - 40)), qPrintable(screen->name()));
        }

        // Outside the pill and the panel, a click reaches the app underneath.
        const QRect primary = QGuiApplication::primaryScreen()->geometry();
        QVERIFY(clickAt(primary.topLeft() + QPoint(primary.width() / 2, primary.height() - 60)));
        QTRY_COMPARE(app->property("clicks").toInt(), 1);

        // Take over is a real button on the overlay.
        auto* takeOver = overlay.primaryWindow()->findChild<QQuickItem*>(u"cuTakeOver"_s);
        QVERIFY(takeOver);
        const QPointF centre = takeOver->mapToScene(QPointF(takeOver->width() / 2, takeOver->height() / 2));
        QVERIFY(clickAt(primary.topLeft() + centre.toPoint()));
        QTRY_COMPARE(stops.size(), 1);
        QCOMPARE(app->property("clicks").toInt(), 1);

        session.applyState(QJsonObject{{"active", false}});
        QTest::qWait(500);
        const QImage after = grab(QGuiApplication::primaryScreen()->name(), dir.path());
        QVERIFY(!isTeal(after.pixel(1, 1)));
        delete app;
    }

    void outputUnplugFollowsTheScreens()
    {
        QQmlEngine engine;
        engine.addImportPath(QStringLiteral(JARVIS_QML_DIR));
        CuSessionModel session;
        CuOverlayManager overlay(&engine, &session, true);
        session.applyState(running());
        QTRY_COMPARE(overlay.windows().size(), 2);
        const QString second = QGuiApplication::screens().at(1)->name();
        QVERIFY(run(u"wlr-randr"_s, {u"--output"_s, second, u"--off"_s}));
        QTRY_COMPARE_WITH_TIMEOUT(overlay.windows().size(), 1, 5000);
        QVERIFY(run(u"wlr-randr"_s, {u"--output"_s, second, u"--on"_s}));
        QTRY_COMPARE_WITH_TIMEOUT(overlay.windows().size(), 2, 5000);
        for (QQuickWindow* w : overlay.windows())
            QTRY_VERIFY_WITH_TIMEOUT(w->isExposed(), 5000);
        QTemporaryDir dir;
        QTest::qWait(500);
        const QImage shot = grab(second, dir.path());
        QVERIFY(!shot.isNull());
        QVERIFY(isTeal(shot.pixel(1, 1)));
    }
};

QTEST_MAIN(TestOverlayWayland)
#include "tst_overlay_wayland.moc"
