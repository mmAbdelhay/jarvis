#include <QGuiApplication>
#include <QSignalSpy>
#include <QtTest>

#include "FakePower.h"
#include "JarvisFont.h"

using namespace Qt::StringLiterals;

class TestNative : public QObject {
    Q_OBJECT
private slots:
    void fontIsPlexAtTheScaledSize()
    {
        jarvis::ui::applyJarvisFont();
        QCOMPARE(QGuiApplication::font().family(), u"IBM Plex Sans"_s);
        QCOMPARE(QGuiApplication::font().pixelSize(), 15);
        jarvis::ui::applyJarvisFont(1.25);
        QCOMPARE(QGuiApplication::font().pixelSize(), 19);
    }

    void fakePowerRecords()
    {
        FakePower power;
        PowerActions* actions = &power;
        QVERIFY(actions->available());
        actions->reboot();
        actions->powerOff();
        QCOMPARE(power.calls, (QStringList{u"Reboot"_s, u"PowerOff"_s}));
    }
};

QTEST_MAIN(TestNative)
#include "tst_native.moc"
