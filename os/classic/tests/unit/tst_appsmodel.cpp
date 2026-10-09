#include <QCoreApplication>
#include <QSignalSpy>
#include <QtTest>

#include "AppsModel.h"

using namespace Qt::StringLiterals;

namespace {
const QString kApps = QStringLiteral(JARVIS_CLASSIC_TEST_DATA "/applications");
QStringList ids(const AppsModel& m)
{
    QStringList out;
    for (int i = 0; i < m.rowCount(); ++i)
        out << m.idAt(i);
    return out;
}
} // namespace

class TestAppsModel : public QObject {
    Q_OBJECT
private slots:
    void init() { QCoreApplication::instance()->setProperty("jarvisLanguage", u"en"_s); }

    void listsOnlyUsableApplicationsSortedByName()
    {
        AppsModel model({kApps}, {u"labwc"_s, u"wlroots"_s});
        QCOMPARE(ids(model), (QStringList{u"firefox"_s, u"foot"_s, u"htop"_s, u"shellthing"_s}));
        QCOMPARE(model.data(model.index(0), model.roleNames().key("name")).toString(), u"Firefox ESR"_s);
        QCOMPARE(model.data(model.index(0), model.roleNames().key("comment")).toString(), u"Browse the web"_s);
    }

    void desktopFiltersAreCaseInsensitive()
    {
        AppsModel model({kApps}, {u"GNOME"_s});
        QVERIFY(ids(model).contains(u"gnomeonly"_s));
        QVERIFY(ids(model).contains(u"notlabwc"_s));
        AppsModel lower({kApps}, {u"gnome"_s});
        QVERIFY(ids(lower).contains(u"gnomeonly"_s));
    }

    void arabicNamesAfterRetranslate()
    {
        AppsModel model({kApps}, {u"labwc"_s});
        QCoreApplication::instance()->setProperty("jarvisLanguage", u"ar"_s);
        model.retranslate();
        const int row = int(ids(model).indexOf(u"firefox"_s));
        QCOMPARE(model.data(model.index(row), model.roleNames().key("name")).toString(), u"فايرفوكس"_s);
    }

    void filterMatchesEitherLanguageAndComment()
    {
        QCoreApplication::instance()->setProperty("jarvisLanguage", u"ar"_s);
        AppsModel model({kApps}, {u"labwc"_s});
        QSignalSpy count(&model, &AppsModel::countChanged);
        model.setFilter(u"فاير"_s);
        QCOMPARE(ids(model), QStringList{u"firefox"_s});
        model.setFilter(u"FIRE"_s);
        QCOMPARE(ids(model), QStringList{u"firefox"_s});
        model.setFilter(u"web"_s);
        QCOMPARE(ids(model), QStringList{u"firefox"_s});
        model.setFilter(QString());
        QCOMPARE(model.rowCount(), 4);
        QVERIFY(count.size() >= 2);
    }

    void currentDesktopsSplitsTheVariable()
    {
        qputenv("XDG_CURRENT_DESKTOP", "labwc:wlroots");
        QCOMPARE(AppsModel::currentDesktops(), (QStringList{u"labwc"_s, u"wlroots"_s}));
    }
};

QTEST_GUILESS_MAIN(TestAppsModel)
#include "tst_appsmodel.moc"
