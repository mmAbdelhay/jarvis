#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QtTest>

#include "app/ClassicRedirect.h"

using namespace Qt::StringLiterals;

class TestFallbackRedirect : public QObject {
    Q_OBJECT
private slots:
    void markerLivesInTheRuntimeDir()
    {
        qputenv("XDG_RUNTIME_DIR", "/run/user/1000");
        QCOMPARE(jarvis::shell::classicMarkerPath(), u"/run/user/1000/jarvis/classic-fallback"_s);
    }

    void noMarkerNoRedirect()
    {
        QTemporaryDir dir;
        int starts = 0;
        QVERIFY(!jarvis::shell::redirectToClassic(dir.filePath(u"jarvis/classic-fallback"_s),
                                                  [&](const QString&, const QStringList&) { ++starts; return true; }));
        QCOMPARE(starts, 0);
    }

    void markerOpensTheClassicChat()
    {
        QTemporaryDir dir;
        QVERIFY(QDir(dir.path()).mkpath(u"jarvis"_s));
        const QString marker = dir.filePath(u"jarvis/classic-fallback"_s);
        QFile(marker).open(QIODevice::WriteOnly);
        QString program;
        QStringList args;
        QVERIFY(jarvis::shell::redirectToClassic(marker, [&](const QString& p, const QStringList& a) {
            program = p;
            args = a;
            return true;
        }));
        QCOMPARE(program, u"jarvis-classic"_s);
        QCOMPARE(args, QStringList{u"--chat"_s});
    }

    void failedStartFallsThroughToTheShell()
    {
        QTemporaryDir dir;
        QVERIFY(QDir(dir.path()).mkpath(u"jarvis"_s));
        const QString marker = dir.filePath(u"jarvis/classic-fallback"_s);
        QFile(marker).open(QIODevice::WriteOnly);
        QVERIFY(!jarvis::shell::redirectToClassic(marker, [](const QString&, const QStringList&) { return false; }));
    }
};

QTEST_GUILESS_MAIN(TestFallbackRedirect)
#include "tst_fallbackredirect.moc"
