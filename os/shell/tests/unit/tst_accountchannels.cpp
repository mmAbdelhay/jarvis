#include <QtTest>

#include "ShellFixture.h"
#include "models/AccountsModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonArray args(const QJsonObject& request) { return request.value("a").toArray(); }
QJsonObject noneInstalled()
{
    QJsonArray rows;
    for (const char* id : {"claude", "chatgpt", "gemini", "copilot"})
        rows.append(QJsonObject{{"account", id}, {"installed", false}, {"version", QJsonValue()}, {"signedIn", false}, {"identity", QJsonValue()}});
    return {{"accounts", rows}};
}
} // namespace

class TestAccountChannels : public QObject {
    Q_OBJECT
private slots:
    void statusOnConnect()
    {
        ShellFixture f;
        f.replies.insert(u"account:status"_s, {true, noneInstalled()});
        QVERIFY(f.open());
        QTRY_VERIFY(f.shell->accounts()->known());
        QCOMPARE(f.requests(u"account:status"_s).size(), 1);
    }

    void installThenLoginThenSignOutAndRemove()
    {
        ShellFixture f;
        f.replies.insert(u"account:status"_s, {true, noneInstalled()});
        QVERIFY(f.open());
        AccountsModel* a = f.shell->accounts();
        QTRY_VERIFY(a->known());
        a->setSelected(u"gemini"_s);
        a->signIn();
        QTRY_COMPARE(f.requests(u"account:install"_s).size(), 1);
        QCOMPARE(args(f.requests(u"account:install"_s).first()), (QJsonArray{QJsonObject{{"account", "gemini"}}}));
        f.push(u"account:state"_s, QJsonObject{{"account", "gemini"}, {"phase", "installed"}, {"message", "Google is ready."}});
        QTRY_COMPARE(f.requests(u"account:login"_s).size(), 1);
        f.push(u"account:state"_s, QJsonObject{{"account", "gemini"}, {"phase", "awaiting-browser"}, {"url", "https://accounts.google.com/o/oauth2/v2/auth"}});
        QTRY_COMPARE(a->phase(), u"awaiting-browser"_s);
        a->signOut(u"gemini"_s);
        QTRY_COMPARE(f.requests(u"account:logout"_s).size(), 1);
        a->remove(u"gemini"_s);
        QTRY_COMPARE(f.requests(u"account:uninstall"_s).size(), 1);
        QTRY_VERIFY(f.requests(u"account:status"_s).size() >= 3); // refreshed after each
    }

    void refreshesOnSettingsAndSignedIn()
    {
        ShellFixture f;
        f.replies.insert(u"account:status"_s, {true, noneInstalled()});
        QVERIFY(f.open());
        QTRY_VERIFY(f.shell->accounts()->known());
        f.shell->showView(u"settings"_s);
        QTRY_COMPARE(f.requests(u"account:status"_s).size(), 2);
        f.push(u"account:state"_s, QJsonObject{{"account", "claude"}, {"phase", "signed-in"}});
        QTRY_COMPARE(f.requests(u"account:status"_s).size(), 3);
    }

    void requestErrorShowsOnTheAccount()
    {
        ShellFixture f;
        f.replies.insert(u"account:status"_s, {true, noneInstalled()});
        f.replies.insert(u"account:install"_s, {false, {}, u"unsupported"_s, u"Signing in with an account is not available on this system."_s});
        QVERIFY(f.open());
        AccountsModel* a = f.shell->accounts();
        a->setSelected(u"claude"_s);
        a->signIn();
        QTRY_COMPARE(a->phase(), u"failed"_s);
        QCOMPARE(a->statusLine(), u"Signing in with an account is not available on this system."_s);
    }
};

QTEST_MAIN(TestAccountChannels)
#include "tst_accountchannels.moc"
