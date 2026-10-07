#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>

#include "app/SingleInstance.h"

using namespace Qt::StringLiterals;

class TestSingleInstance : public QObject {
    Q_OBJECT
private slots:
    void forwardFailsWithoutARunningShell()
    {
        QTemporaryDir dir(u"/tmp/jsh-si-XXXXXX"_s);
        SingleInstance instance(dir.filePath(u"shell.sock"_s));
        QVERIFY(!instance.forward("focus", 200));
    }

    void secondLaunchHandsOverToTheFirst()
    {
        QTemporaryDir dir(u"/tmp/jsh-si-XXXXXX"_s);
        const QString name = dir.filePath(u"shell.sock"_s);
        SingleInstance first(name);
        QVERIFY(first.listen());
        QSignalSpy messages(&first, &SingleInstance::messageReceived);
        SingleInstance second(name);
        QVERIFY(second.forward("focus"));
        QVERIFY(messages.wait(2000));
        QCOMPARE(messages[0][0].toByteArray(), QByteArray("focus"));
    }

    void staleSocketIsReplaced()
    {
        QTemporaryDir dir(u"/tmp/jsh-si-XXXXXX"_s);
        const QString name = dir.filePath(u"shell.sock"_s);
        QFile stale(name);
        QVERIFY(stale.open(QIODevice::WriteOnly)); // a leftover file from a crashed shell
        stale.close();
        SingleInstance instance(name);
        QVERIFY(instance.listen());
    }

    void defaultNameUsesTheRuntimeDir()
    {
        qputenv("XDG_RUNTIME_DIR", "/run/user/1000");
        QCOMPARE(SingleInstance::defaultName(), u"/run/user/1000/jarvis-shell.sock"_s);
        qunsetenv("XDG_RUNTIME_DIR");
        QVERIFY(SingleInstance::defaultName().endsWith(u".sock"_s));
    }
};

QTEST_GUILESS_MAIN(TestSingleInstance)
#include "tst_singleinstance.moc"
