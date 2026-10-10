#include <QtTest>

#include "app/AppIconProvider.h"

using namespace Qt::StringLiterals;

class TestAppIconProvider : public QObject {
    Q_OBJECT
private slots:
    void onlyIconFoldersMayBeRead()
    {
        QVERIFY(AppIconProvider::allowedIconPath(u"/usr/share/pixmaps/gimp.png"_s));
        QVERIFY(AppIconProvider::allowedIconPath(u"/usr/share/icons/hicolor/48x48/apps/x.svg"_s));
        QVERIFY(AppIconProvider::allowedIconPath(u"/var/lib/flatpak/exports/share/icons/hicolor/64x64/apps/org.gimp.GIMP.png"_s));
        QVERIFY(!AppIconProvider::allowedIconPath(u"/home/u/.ssh/id_ed25519"_s));
        QVERIFY(!AppIconProvider::allowedIconPath(u"/usr/share/icons/../../../etc/shadow.png"_s));
        QVERIFY(!AppIconProvider::allowedIconPath(u"/usr/share/pixmaps/readme.txt"_s));
    }

    void refusesThemeNamesWithSlashes()
    {
        AppIconProvider provider;
        QSize size;
        QVERIFY(provider.requestPixmap(u"..%2Fetc%2Fshadow"_s, &size, QSize(48, 48)).isNull());
        QVERIFY(provider.requestPixmap(u"%2Fhome%2Fu%2Fsecret.png"_s, &size, QSize(48, 48)).isNull());
    }
};

QTEST_MAIN(TestAppIconProvider)
#include "tst_appiconprovider.moc"
