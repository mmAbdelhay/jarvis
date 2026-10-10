#include <QFile>
#include <QTemporaryDir>
#include <QtTest>

#include "DesktopEntry.h"

using namespace Qt::StringLiterals;
using namespace jarvis::ui;

namespace {
const QString kDir = QStringLiteral(JARVIS_TEST_DESKTOP_DIR);
QString fixture(const QString& name) { return kDir + u"/desktop/"_s + name; }
} // namespace

class TestDesktopEntry : public QObject {
    Q_OBJECT
private slots:
    void parsesTheMainGroupOnly()
    {
        const auto e = parseDesktopEntry(fixture(u"firefox.desktop"_s));
        QVERIFY(e.has_value());
        QCOMPARE(e->id, u"firefox"_s);
        QCOMPARE(e->type, u"Application"_s);
        QCOMPARE(e->name(u"en"_s), u"Firefox ESR"_s);
        QCOMPARE(e->name(u"ar"_s), u"فايرفوكس"_s);
        QCOMPARE(e->comment(u"ar"_s), u"تصفح الويب"_s); // Comment[ar_EG] serves "ar"
        QCOMPARE(e->exec, u"firefox-esr %u"_s);          // not the action's Exec
        QCOMPARE(e->categories, (QStringList{u"Network"_s, u"WebBrowser"_s}));
        QVERIFY(!e->terminal);
        QVERIFY(!e->noDisplay);
    }

    void flagsAndLists()
    {
        const auto e = parseDesktopEntry(fixture(u"hidden.desktop"_s));
        QVERIFY(e.has_value());
        QVERIFY(e->noDisplay);
        QCOMPARE(e->onlyShowIn, (QStringList{u"GNOME"_s, u"KDE"_s}));
    }

    void incompleteFilesAreRejected()
    {
        QVERIFY(!parseDesktopEntry(fixture(u"noname.desktop"_s)).has_value());
        QVERIFY(!parseDesktopEntry(fixture(u"actions.desktop"_s)).has_value());
        QVERIFY(!parseDesktopEntry(fixture(u"missing.desktop"_s)).has_value());
    }

    void oversizedFileIsSkipped()
    {
        QTemporaryDir dir;
        QFile big(dir.filePath(u"big.desktop"_s));
        QVERIFY(big.open(QIODevice::WriteOnly));
        big.write("[Desktop Entry]\nName=Big\nExec=big\nComment=");
        big.write(QByteArray(5 * 1024 * 1024, 'x'));
        big.close();
        QVERIFY(!parseDesktopEntry(big.fileName()).has_value());
    }

    void invalidUtf8IsSkipped()
    {
        QTemporaryDir dir;
        QFile bad(dir.filePath(u"bad.desktop"_s));
        QVERIFY(bad.open(QIODevice::WriteOnly));
        bad.write("[Desktop Entry]\nName=Bad\xff\xfe\nExec=bad\n");
        bad.close();
        QVERIFY(!parseDesktopEntry(bad.fileName()).has_value());
    }

    void splitsExec_data()
    {
        QTest::addColumn<QString>("exec");
        QTest::addColumn<QStringList>("argv");
        QTest::newRow("plain") << u"foot -e htop"_s << QStringList{u"foot"_s, u"-e"_s, u"htop"_s};
        QTest::newRow("url code") << u"firefox-esr %u"_s << QStringList{u"firefox-esr"_s};
        QTest::newRow("quoted") << u"\"/opt/My App/run\" --flag \"a \\\"b\\\"\" %F"_s
                                << QStringList{u"/opt/My App/run"_s, u"--flag"_s, u"a \"b\""_s};
        QTest::newRow("percent") << u"app --level=100%%"_s << QStringList{u"app"_s, u"--level=100%"_s};
        QTest::newRow("quoted code") << u"app \"%f\""_s << QStringList{u"app"_s};
        QTest::newRow("quoted metachars") << u"sh -c \"echo a; echo b\""_s
                                          << QStringList{u"sh"_s, u"-c"_s, u"echo a; echo b"_s};
        QTest::newRow("tabs") << u"app\t-x"_s << QStringList{u"app"_s, u"-x"_s};
    }
    void splitsExec()
    {
        QFETCH(QString, exec);
        QFETCH(QStringList, argv);
        const auto got = splitExec(exec);
        QVERIFY2(got.has_value(), qPrintable(exec));
        QCOMPARE(*got, argv);
    }

    void fieldCodesAndFlatpakMarkersAreDropped()
    {
        const auto e = parseDesktopEntry(fixture(u"flatpak.desktop"_s));
        QVERIFY(e.has_value());
        QCOMPARE(*splitExec(e->exec),
                 (QStringList{u"/usr/bin/flatpak"_s, u"run"_s, u"--branch=stable"_s, u"--arch=x86_64"_s,
                              u"--command=gimp"_s, u"org.gimp.GIMP"_s}));
        const auto q = parseDesktopEntry(fixture(u"quoted.desktop"_s));
        QCOMPARE(*splitExec(q->exec), (QStringList{u"/opt/My App/run"_s, u"--flag"_s, u"a \"b\""_s}));
    }

    void shellMetacharactersAreRejected_data()
    {
        QTest::addColumn<QString>("exec");
        for (const QString& bad : {u"true; rm -rf ~"_s, u"app | tee x"_s, u"app && evil"_s, u"app $(id)"_s,
                                   u"app `id`"_s, u"app > /tmp/x"_s, u"app < /etc/passwd"_s, u"\"unbalanced"_s,
                                   u"app %z"_s, u"app %"_s, u""_s, u"   "_s, u"app \\x"_s, u"\"\" -x"_s, u"@@u"_s, u"@@u %U @@"_s, u"@@ %U @@"_s, u"@@ evil"_s, u"%f"_s})
            QTest::newRow(qPrintable(bad.isEmpty() ? u"(empty)"_s : bad)) << bad;
    }
    void shellMetacharactersAreRejected()
    {
        QFETCH(QString, exec);
        QVERIFY(!splitExec(exec).has_value());
        const auto e = parseDesktopEntry(fixture(u"shell.desktop"_s));
        QVERIFY(e.has_value());
        QVERIFY(!splitExec(e->exec).has_value());
    }

    void firstDirectoryWins()
    {
        const QList<DesktopEntry> all = readDesktopEntries({kDir + u"/desktop-user"_s, kDir + u"/desktop"_s});
        QStringList ids;
        QString firefoxName;
        for (const DesktopEntry& e : all) {
            ids << e.id;
            if (e.id == u"firefox")
                firefoxName = e.name(u"en"_s);
        }
        QCOMPARE(firefoxName, u"My Firefox"_s);
        QCOMPARE(ids.count(u"firefox"_s), 1);
        QVERIFY(!ids.contains(u"flatpak"_s)); // user Hidden=true tombstone hides the system entry
        QVERIFY(!ids.contains(u"noname"_s)); // unparsable files are left out
    }

    void applicationDirectoriesFollowXdgAndFlatpak()
    {
        qputenv("XDG_DATA_HOME", "/home/u/.local/share");
        qputenv("XDG_DATA_DIRS", "/usr/local/share:/usr/share:/var/lib/flatpak/exports/share");
        QCOMPARE(applicationDirectories(),
                 (QStringList{u"/home/u/.local/share/applications"_s, u"/usr/local/share/applications"_s,
                              u"/usr/share/applications"_s, u"/var/lib/flatpak/exports/share/applications"_s,
                              u"/home/u/.local/share/flatpak/exports/share/applications"_s}));
        qunsetenv("XDG_DATA_DIRS");
        QCOMPARE(applicationDirectories().mid(1),
                 (QStringList{u"/usr/local/share/applications"_s, u"/usr/share/applications"_s,
                              u"/home/u/.local/share/flatpak/exports/share/applications"_s,
                              u"/var/lib/flatpak/exports/share/applications"_s}));
    }
};

QTEST_GUILESS_MAIN(TestDesktopEntry)
#include "tst_desktopentry.moc"
