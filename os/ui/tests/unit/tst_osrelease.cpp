#include <QTemporaryDir>
#include <QtTest>

#include "OsRelease.h"

using namespace Qt::StringLiterals;

class TestOsRelease : public QObject {
    Q_OBJECT

    QTemporaryDir m_dir;

    QString write(const QByteArray& content)
    {
        static int n = 0;
        const QString path = m_dir.filePath(u"os-release-%1"_s.arg(++n));
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly))
            qFatal("cannot write %s", qPrintable(path));
        file.write(content);
        return path;
    }

private slots:
    void quotedName() { QCOMPARE(jarvis::ui::distroName(write("ID=x\nNAME=\"Nova OS\"\n")), u"Nova OS"_s); }
    void singleQuotedName() { QCOMPARE(jarvis::ui::distroName(write("NAME='Nova OS'\n")), u"Nova OS"_s); }
    void bareName() { QCOMPARE(jarvis::ui::distroName(write("NAME=Nova\n")), u"Nova"_s); }
    void escapes() { QCOMPARE(jarvis::ui::distroName(write("NAME=\"Nova \\\"X\\\" OS\"\n")), u"Nova \"X\" OS"_s); }
    void prettyNameIsNotName() { QCOMPARE(jarvis::ui::distroName(write("PRETTY_NAME=\"Other\"\n")), u"Rafiq"_s); }
    void emptyNameFallsBack() { QCOMPARE(jarvis::ui::distroName(write("NAME=\"\"\n")), u"Rafiq"_s); }
    void missingFileFallsBack() { QCOMPARE(jarvis::ui::distroName(m_dir.filePath(u"nope"_s)), u"Rafiq"_s); }
    // M4 contracts §6.8: /usr/share/jarvis/brand.json localizes the name;
    // os-release NAME is the fallback.
    void brandJsonNamesTheDistroPerLanguage()
    {
        const QString osr = write("NAME=\"Nova OS\"\n");
        const QString brand = write("{\"name\": {\"en\": \"Rafiq\", \"ar\": \"\xd8\xb1\xd9\x81\xd9\x8a\xd9\x82\"}}\n");
        QCOMPARE(jarvis::ui::localizedDistroName(u"ar"_s, brand, osr), u"\u0631\u0641\u064a\u0642"_s);
        QCOMPARE(jarvis::ui::localizedDistroName(u"en"_s, brand, osr), u"Rafiq"_s);
    }
    void brandJsonFallsBackToOsRelease()
    {
        const QString osr = write("NAME=\"Nova OS\"\n");
        QCOMPARE(jarvis::ui::localizedDistroName(u"ar"_s, m_dir.filePath(u"none.json"_s), osr), u"Nova OS"_s);
        QCOMPARE(jarvis::ui::localizedDistroName(u"ar"_s, write("not json"), osr), u"Nova OS"_s);
        QCOMPARE(jarvis::ui::localizedDistroName(u"ar"_s, write("{\"name\": {\"en\": \"Rafiq\"}}"), osr), u"Nova OS"_s);
        QCOMPARE(jarvis::ui::localizedDistroName(u"ar"_s, write("{\"name\": {\"ar\": \"  \"}}"), osr), u"Nova OS"_s);
        QCOMPARE(jarvis::ui::localizedDistroName(u"ar"_s, write("{\"name\": {\"ar\": 7}}"), osr), u"Nova OS"_s);
    }
    void brandEnvOverridesThePath()
    {
        const QString path = write("{}");
        qputenv("JARVIS_BRAND_JSON", path.toUtf8());
        QCOMPARE(jarvis::ui::brandPath(), path);
        qunsetenv("JARVIS_BRAND_JSON");
        QCOMPARE(jarvis::ui::brandPath(), u"/usr/share/jarvis/brand.json"_s);
    }
    void envOverridesThePath()
    {
        const QString path = write("NAME=\"Env OS\"\n");
        qputenv("JARVIS_OS_RELEASE", path.toUtf8());
        QCOMPARE(jarvis::ui::osReleasePath(), path);
        QCOMPARE(jarvis::ui::distroName(), u"Env OS"_s);
        qunsetenv("JARVIS_OS_RELEASE");
        QCOMPARE(jarvis::ui::osReleasePath(), u"/etc/os-release"_s);
    }
};

QTEST_GUILESS_MAIN(TestOsRelease)
#include "tst_osrelease.moc"
