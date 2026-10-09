#include <QFile>
#include <QTemporaryDir>
#include <QtTest>

#include "LiveKeyboard.h"

using namespace Qt::StringLiterals;

namespace {
QString read(const QString& path)
{
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? QString::fromUtf8(f.readAll()) : QString();
}
void write(const QString& path, const QByteArray& data)
{
    QFile f(path);
    QVERIFY(f.open(QIODevice::WriteOnly));
    f.write(data);
}
struct Setup {
    QTemporaryDir dir;
    QString system() const { return dir.filePath(u"system-environment"_s); }
    QString config() const { return dir.filePath(u"config"_s); }
    QString user() const { return dir.filePath(u"config/labwc/environment"_s); }
    QString marker() const { return dir.filePath(u"reconfigured"_s); }
    QStringList touch() const { return {u"/bin/sh"_s, u"-c"_s, u"echo x >> \"$0\""_s, marker()}; }
};
} // namespace

// The installer's Welcome keyboard must also be the live session's, so the
// password and passphrase are typed with the layout the target will use
// (contracts §11.5).
class TestLiveKeyboard : public QObject {
    Q_OBJECT
private slots:
    void writesTheSystemFileWithTheChosenLayoutAndReconfigures()
    {
        Setup s;
        write(s.system(), "# comment\nQT_QPA_PLATFORM=wayland\nXKB_DEFAULT_LAYOUT=us\nXKB_DEFAULT_VARIANT=intl\nWLR_RENDERER_ALLOW_SOFTWARE=1\n");
        LiveKeyboard kb(s.config(), s.system(), s.touch());
        QVERIFY(kb.apply(u"fr(azerty)"_s));
        QCOMPARE(read(s.user()), u"# comment\nQT_QPA_PLATFORM=wayland\nWLR_RENDERER_ALLOW_SOFTWARE=1\n"
                                  "XKB_DEFAULT_LAYOUT=fr\nXKB_DEFAULT_VARIANT=azerty\n"_s);
        QVERIFY(QTest::qWaitFor([&] { return QFile::exists(s.marker()); }, 5000));

        QVERIFY(kb.apply(u"de"_s));
        QVERIFY(read(s.user()).endsWith(u"XKB_DEFAULT_LAYOUT=de\nXKB_DEFAULT_VARIANT=\n"_s));
        QCOMPARE(read(s.user()).count(u"XKB_"_s), 2);
    }

    void worksWithoutASystemFile()
    {
        Setup s;
        LiveKeyboard kb(s.config(), s.dir.filePath(u"missing"_s), s.touch());
        QVERIFY(kb.apply(u"ara"_s));
        QCOMPARE(read(s.user()), u"XKB_DEFAULT_LAYOUT=ara\nXKB_DEFAULT_VARIANT=\n"_s);
    }

    void rejectsAnythingThatIsNotALayout_data()
    {
        QTest::addColumn<QString>("keyboard");
        QTest::newRow("newline") << u"us\nEVIL=1"_s;
        QTest::newRow("space in variant") << u"fr(a b)"_s;
        QTest::newRow("empty") << QString();
        QTest::newRow("unclosed") << u"fr(azerty"_s;
        QTest::newRow("upper") << u"US"_s;
    }
    void rejectsAnythingThatIsNotALayout()
    {
        QFETCH(QString, keyboard);
        Setup s;
        LiveKeyboard kb(s.config(), s.system(), s.touch());
        QVERIFY(!kb.apply(keyboard));
        QVERIFY(!QFile::exists(s.user()));
        QTest::qWait(100);
        QVERIFY(!QFile::exists(s.marker()));
    }

    void failsWhenTheCompositorCannotBeAsked()
    {
        Setup s;
        LiveKeyboard kb(s.config(), s.system(), {s.dir.filePath(u"no-such-labwc"_s), u"--reconfigure"_s});
        QVERIFY(!kb.apply(u"fr"_s));
    }
};

QTEST_GUILESS_MAIN(TestLiveKeyboard)
#include "tst_livekeyboard.moc"
