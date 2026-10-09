#include <QtTest>

#include "core/IdleConfig.h"

using namespace Qt::StringLiterals;

class TestIdleConfig : public QObject {
    Q_OBJECT
private slots:
    void reads_data()
    {
        QTest::addColumn<QString>("yaml");
        QTest::addColumn<int>("minutes");
        QTest::newRow("absent") << u"os:\n  memory: { enabled: true }\n"_s << 10;
        QTest::newRow("top level") << u"idle:\n  lockAfterMinutes: 5\n"_s << 5;
        QTest::newRow("under os") << u"os:\n  providers: []\n  idle:\n    lockAfterMinutes: 15 # comment\n"_s << 15;
        QTest::newRow("flow") << u"os:\n  idle: { lockAfterMinutes: 3 }\n"_s << 3;
        QTest::newRow("quoted") << u"idle:\n  lockAfterMinutes: \"7\"\n"_s << 7;
        QTest::newRow("never") << u"idle:\n  lockAfterMinutes: 0\n"_s << 0;
        QTest::newRow("clamped") << u"idle:\n  lockAfterMinutes: 999\n"_s << 240;
        QTest::newRow("negative") << u"idle:\n  lockAfterMinutes: -4\n"_s << 0;
        QTest::newRow("garbage") << u"idle:\n  lockAfterMinutes: soon\n"_s << 10;
        QTest::newRow("other parent") << u"memory:\n  idle:\n    lockAfterMinutes: 2\n"_s << 10;
        QTest::newRow("sibling after") << u"idle:\n  lockAfterMinutes: 4\nother:\n  lockAfterMinutes: 9\n"_s << 4;
    }
    void reads()
    {
        QFETCH(QString, yaml);
        QFETCH(int, minutes);
        QCOMPARE(lockAfterMinutesFromText(yaml), minutes);
    }

    void missingFileGivesTheDefault()
    {
        QCOMPARE(lockAfterMinutes(u"/nonexistent/jarvis.yaml"_s), kDefaultLockAfterMinutes);
    }

    void defaultPathIsUnderXdgConfig()
    {
        qputenv("XDG_CONFIG_HOME", "/tmp/xdg-test");
        QCOMPARE(defaultConfigPath(), u"/tmp/xdg-test/jarvis/jarvis.yaml"_s);
        qunsetenv("XDG_CONFIG_HOME");
        QVERIFY(defaultConfigPath().endsWith(u"/.config/jarvis/jarvis.yaml"_s));
    }
};

QTEST_GUILESS_MAIN(TestIdleConfig)
#include "tst_idleconfig.moc"
