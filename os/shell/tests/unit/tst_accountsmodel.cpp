#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>

#include "models/AccountsModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject status(bool claudeInstalled, bool claudeSignedIn)
{
    QJsonArray accounts;
    accounts.append(QJsonObject{{"account", "claude"}, {"installed", claudeInstalled}, {"version", claudeInstalled ? "2.1.280" : QJsonValue()},
                                {"signedIn", claudeSignedIn}, {"identity", claudeSignedIn ? "sara@example.com" : QJsonValue()}});
    for (const char* id : {"chatgpt", "gemini", "copilot"})
        accounts.append(QJsonObject{{"account", id}, {"installed", false}, {"version", QJsonValue()}, {"signedIn", false}, {"identity", QJsonValue()}});
    return QJsonObject{{"accounts", accounts}};
}
} // namespace

class TestAccountsModel : public QObject {
    Q_OBJECT
private slots:
    void labelsAndUrls()
    {
        QCOMPARE(AccountsModel::label(u"gemini"_s), u"Google"_s);
        QCOMPARE(AccountsModel::label(u"copilot"_s), u"GitHub Copilot"_s);
        QCOMPARE(AccountsModel::accountForUrl(u"https://chatgpt.com"_s), u"chatgpt"_s);
        QCOMPARE(AccountsModel::displayUrl(u"claude"_s), u"https://claude.ai"_s);
        QVERIFY(!AccountsModel::isAccount(u"bard"_s));
    }

    void statusFillsRows()
    {
        AccountsModel model;
        QCOMPARE(model.rowCount(), 4);
        QVERIFY(!model.known());
        model.applyStatus(status(true, true));
        QVERIFY(model.known());
        QCOMPARE(model.data(model.index(0), AccountsModel::StatusTextRole).toString(), u"Signed in as sara@example.com"_s);
        QCOMPARE(model.data(model.index(1), AccountsModel::StatusTextRole).toString(), u"Not set up"_s);
        QVERIFY(model.selectedSignedIn());
        QCOMPARE(model.selectedIdentity(), u"sara@example.com"_s);
    }

    void signInInstallsFirstThenLogsIn()
    {
        AccountsModel model;
        model.applyStatus(status(false, false));
        model.setSelected(u"claude"_s);
        QSignalSpy install(&model, &AccountsModel::installRequested);
        QSignalSpy login(&model, &AccountsModel::loginRequested);
        model.signIn();
        QCOMPARE(install.count(), 1);
        QCOMPARE(install.at(0).at(0).toString(), u"claude"_s);
        QVERIFY(model.busy());
        model.applyState(QJsonObject{{"account", "claude"}, {"phase", "installing"}, {"message", "Downloading Claude…"}});
        QCOMPARE(model.statusLine(), u"Downloading Claude…"_s);
        model.applyState(QJsonObject{{"account", "claude"}, {"phase", "installed"}, {"message", "Claude is ready."}});
        QCOMPARE(login.count(), 1);
        model.applyState(QJsonObject{{"account", "claude"}, {"phase", "awaiting-browser"}, {"url", "https://claude.ai/oauth/authorize?x=1"}});
        QCOMPARE(model.phase(), u"awaiting-browser"_s);
        QCOMPARE(model.url(), u"https://claude.ai/oauth/authorize?x=1"_s);
        QSignalSpy signedIn(&model, &AccountsModel::signedIn);
        model.applyState(QJsonObject{{"account", "claude"}, {"phase", "signed-in"}, {"identity", "sara@example.com"}});
        QCOMPARE(signedIn.count(), 1);
        QVERIFY(model.selectedSignedIn());
        QVERIFY(!model.busy());
        QVERIFY(model.url().isEmpty());
    }

    void showsCopilotsCode()
    {
        AccountsModel model;
        model.setSelected(u"copilot"_s);
        model.applyState(QJsonObject{{"account", "copilot"}, {"phase", "awaiting-browser"}, {"url", "https://github.com/login/device"}, {"code", "WDJB-MJHT"}});
        QCOMPARE(model.code(), u"WDJB-MJHT"_s);
    }

    void refusesANonHttpsUrl()
    {
        AccountsModel model;
        model.setSelected(u"gemini"_s);
        model.applyState(QJsonObject{{"account", "gemini"}, {"phase", "awaiting-browser"}, {"url", "file:///etc/passwd"}});
        QVERIFY(model.url().isEmpty());
        QCOMPARE(model.phase(), u"failed"_s);
    }

    void failureStopsTheChain()
    {
        AccountsModel model;
        model.setSelected(u"gemini"_s);
        QSignalSpy login(&model, &AccountsModel::loginRequested);
        model.signIn();
        model.applyState(QJsonObject{{"account", "gemini"}, {"phase", "failed"}, {"message", "Couldn't download Google."}});
        QCOMPARE(model.phase(), u"failed"_s);
        QCOMPARE(model.statusLine(), u"Couldn't download Google."_s);
        model.applyState(QJsonObject{{"account", "gemini"}, {"phase", "installed"}});
        QCOMPARE(login.count(), 0);
    }

    void otherAccountsUpdateTheirRowOnly()
    {
        AccountsModel model;
        model.setSelected(u"claude"_s);
        model.applyState(QJsonObject{{"account", "chatgpt"}, {"phase", "signed-in"}, {"identity", "omar@example.com"}});
        QCOMPARE(model.phase(), QString());
        QCOMPARE(model.data(model.index(1), AccountsModel::SignedInRole).toBool(), true);
    }

    void signOutCancelsPendingLoginAndExplainsRevocation()
    {
        AccountsModel model;
        model.setSelected(u"gemini"_s);
        QSignalSpy login(&model, &AccountsModel::loginRequested);
        model.signIn();
        model.signOut(u"gemini"_s);
        QVERIFY(model.statusLine().contains(u"https://myaccount.google.com/connections"));
        model.applyState(QJsonObject{{"account", "gemini"}, {"phase", "installed"}});
        QCOMPARE(login.count(), 0);
        model.setSelected(u"copilot"_s);
        model.signOut(u"copilot"_s);
        QVERIFY(model.statusLine().contains(u"https://github.com/settings/applications"));
    }

    void signOutNonSelectedCopilotShowsRowGuidance()
    {
        AccountsModel model;
        model.applyStatus(status(true, true));
        model.applyState(QJsonObject{{"account", "copilot"}, {"phase", "signed-in"}, {"identity", "omar@example.com"}});
        const QString selectedStatus = model.statusLine();
        QSignalSpy logout(&model, &AccountsModel::logoutRequested);
        QSignalSpy rowsChanged(&model, &AccountsModel::dataChanged);

        model.signOut(u"copilot"_s);

        QCOMPARE(model.selected(), u"claude"_s);
        QCOMPARE(model.statusLine(), selectedStatus);
        QCOMPARE(logout.count(), 1);
        QCOMPARE(logout.at(0).at(0).toString(), u"copilot"_s);
        QVERIFY(model.data(model.index(3), AccountsModel::StatusTextRole).toString()
                    .contains(u"To revoke GitHub Copilot access after signing out, visit https://github.com/settings/applications."));
        QCOMPARE(rowsChanged.count(), 1);
        QCOMPARE(rowsChanged.at(0).at(0).value<QModelIndex>(), model.index(3));
        model.applyStatus(status(true, true));
        QVERIFY(model.data(model.index(3), AccountsModel::StatusTextRole).toString()
                    .contains(u"https://github.com/settings/applications"));
        QVERIFY(!model.data(model.index(0), AccountsModel::StatusTextRole).toString().contains(u"revoke"));
        model.applyState(QJsonObject{{"account", "copilot"}, {"phase", "signed-in"}, {"identity", "omar@example.com"}});
        QCOMPARE(model.data(model.index(3), AccountsModel::StatusTextRole).toString(), u"Signed in as omar@example.com"_s);
    }

    void ignoresGarbage()
    {
        AccountsModel model;
        model.applyState(QJsonObject{{"account", "bard"}, {"phase", "signed-in"}});
        model.applyState(QJsonObject{{"account", "claude"}, {"phase", "exploded"}});
        QCOMPARE(model.phase(), QString());
    }
};

QTEST_MAIN(TestAccountsModel)
#include "tst_accountsmodel.moc"
