#include <QTemporaryFile>
#include <QtTest>

#include "KeyboardLabel.h"

using namespace Qt::StringLiterals;

class TestKeyboardLabel : public QObject {
    Q_OBJECT
    static QString file(const QByteArray& content)
    {
        auto* f = new QTemporaryFile(qApp);
        if (!f->open())
            qFatal("tmp");
        f->write(content);
        f->close();
        return f->fileName();
    }
private slots:
    void firstLayoutWins()
    {
        const QString path = file("XKBMODEL=\"pc105\"\nXKBLAYOUT=\"ara,us\"\nXKBVARIANT=\"\"\n");
        QCOMPARE(keyboardCode(path), u"AR"_s);
        QCOMPARE(keyboardName(path), u"Arabic"_s);
    }
    void usAndGbAreEnglish()
    {
        QCOMPARE(keyboardCode(file("XKBLAYOUT=us\n")), u"EN"_s);
        QCOMPARE(keyboardName(file("XKBLAYOUT=gb\n")), u"English (UK)"_s);
    }
    void unknownAndMissing()
    {
        QCOMPARE(keyboardCode(file("XKBLAYOUT=\"pl\"\n")), u"PL"_s);
        QCOMPARE(keyboardName(file("XKBLAYOUT=\"pl\"\n")), u"pl"_s);
        QCOMPARE(keyboardCode(u"/nonexistent"_s), u"EN"_s);
    }
};

QTEST_GUILESS_MAIN(TestKeyboardLabel)
#include "tst_keyboardlabel.moc"
