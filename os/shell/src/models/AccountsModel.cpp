#include "models/AccountsModel.h"

#include <QClipboard>
#include <QDesktopServices>
#include <QGuiApplication>
#include <QJsonArray>
#include <QUrl>

using namespace Qt::StringLiterals;

namespace {
struct Known {
    QStringView id;
    QStringView label; // vendor names stay in Latin script in every language
    QStringView url;
};
constexpr Known kAccounts[] = {
    {u"claude", u"Claude", u"https://claude.ai"},
    {u"chatgpt", u"ChatGPT", u"https://chatgpt.com"},
    {u"gemini", u"Google", u"https://gemini.google.com"},
    {u"copilot", u"GitHub Copilot", u"https://github.com/copilot"},
};
const QStringList kPhases{u"installing"_s, u"installed"_s, u"failed"_s, u"awaiting-browser"_s, u"signed-in"_s};
} // namespace

AccountsModel::AccountsModel(QObject* parent)
    : QAbstractListModel(parent)
{
    for (const Known& known : kAccounts)
        m_rows.append(Row{known.id.toString()});
}

const QStringList& AccountsModel::ids()
{
    static const QStringList list{u"claude"_s, u"chatgpt"_s, u"gemini"_s, u"copilot"_s};
    return list;
}

bool AccountsModel::isAccount(const QString& account) { return ids().contains(account); }

QString AccountsModel::label(const QString& account)
{
    for (const Known& known : kAccounts)
        if (known.id == account)
            return known.label.toString();
    return {};
}

QString AccountsModel::displayUrl(const QString& account)
{
    for (const Known& known : kAccounts)
        if (known.id == account)
            return known.url.toString();
    return {};
}

QString AccountsModel::accountForUrl(const QString& baseUrl)
{
    QString normalized = baseUrl.trimmed();
    while (normalized.endsWith(u'/'))
        normalized.chop(1);
    for (const Known& known : kAccounts)
        if (known.url == normalized)
            return known.id.toString();
    return {};
}

int AccountsModel::rowCount(const QModelIndex& parent) const { return parent.isValid() ? 0 : int(m_rows.size()); }

QString AccountsModel::statusTextOf(const Row& row) const
{
    if (row.signedIn)
        return tr("Signed in as %1").arg(row.identity.isEmpty() ? label(row.account) : row.identity);
    return row.installed ? tr("Ready to sign in") : tr("Not set up");
}

QVariant AccountsModel::data(const QModelIndex& index, int role) const
{
    if (!index.isValid() || index.model() != this || index.row() < 0 || index.row() >= m_rows.size())
        return {};
    const Row& row = m_rows.at(index.row());
    switch (role) {
    case AccountRole: return row.account;
    case LabelRole: return label(row.account);
    case InstalledRole: return row.installed;
    case VersionRole: return row.version;
    case SignedInRole: return row.signedIn;
    case IdentityRole: return row.identity;
    case StatusTextRole: return statusTextOf(row);
    default: return {};
    }
}

QHash<int, QByteArray> AccountsModel::roleNames() const
{
    return {{AccountRole, "account"}, {LabelRole, "label"}, {InstalledRole, "installed"}, {VersionRole, "version"},
            {SignedInRole, "signedIn"}, {IdentityRole, "identity"}, {StatusTextRole, "statusText"}};
}

int AccountsModel::rowOf(const QString& account) const
{
    for (int i = 0; i < m_rows.size(); ++i)
        if (m_rows.at(i).account == account)
            return i;
    return -1;
}

void AccountsModel::touchRow(int row)
{
    emit dataChanged(index(row), index(row));
    emit changed();
}

void AccountsModel::setSelected(const QString& account)
{
    if (!isAccount(account) || account == m_selected)
        return;
    m_selected = account;
    m_phase.clear();
    m_message.clear();
    m_url.clear();
    m_code.clear();
    m_loginAfterInstall = false;
    emit changed();
}

bool AccountsModel::selectedInstalled() const
{
    const int row = rowOf(m_selected);
    return row >= 0 && m_rows.at(row).installed;
}

bool AccountsModel::selectedSignedIn() const
{
    const int row = rowOf(m_selected);
    return row >= 0 && m_rows.at(row).signedIn;
}

QString AccountsModel::selectedIdentity() const
{
    const int row = rowOf(m_selected);
    return row >= 0 ? m_rows.at(row).identity : QString();
}

bool AccountsModel::busy() const
{
    return m_phase == u"installing" || m_phase == u"starting" || m_phase == u"awaiting-browser";
}

QString AccountsModel::statusLine() const
{
    const QString name = label(m_selected);
    if (m_phase.isEmpty() && !m_message.isEmpty())
        return m_message;
    if (m_phase == u"installing")
        return m_message.isEmpty() ? tr("Getting %1 ready…").arg(name) : m_message;
    if (m_phase == u"starting")
        return tr("Starting %1 sign-in…").arg(name);
    if (m_phase == u"awaiting-browser")
        return tr("Finish signing in to %1 in your browser.").arg(name);
    if (m_phase == u"failed")
        return m_message.isEmpty() ? tr("That didn't work. Try again.") : m_message;
    if (selectedSignedIn())
        return tr("Signed in as %1").arg(selectedIdentity().isEmpty() ? name : selectedIdentity());
    if (selectedInstalled())
        return tr("%1 is set up. Sign in to use it.").arg(name);
    return tr("%1 isn't set up yet. Jarvis installs the official %1 program for you.").arg(name);
}

void AccountsModel::setPhase(const QString& phase, const QString& message)
{
    m_phase = phase;
    m_message = message;
    if (phase != u"awaiting-browser") {
        m_url.clear();
        m_code.clear();
    }
    emit changed();
}

void AccountsModel::applyStatus(const QJsonObject& result)
{
    for (const QJsonValue& value : result.value("accounts").toArray()) {
        const QJsonObject o = value.toObject();
        const int row = rowOf(o.value("account").toString());
        if (row < 0)
            continue;
        Row& r = m_rows[row];
        r.installed = o.value("installed").toBool();
        r.version = o.value("version").toString();
        r.signedIn = o.value("signedIn").toBool();
        r.identity = o.value("identity").toString().left(254);
    }
    m_known = true;
    if (!m_rows.isEmpty())
        emit dataChanged(index(0), index(int(m_rows.size()) - 1));
    emit changed();
}

void AccountsModel::applyState(const QJsonObject& push)
{
    const QString account = push.value("account").toString();
    const QString phase = push.value("phase").toString();
    const int row = rowOf(account);
    if (row < 0 || !kPhases.contains(phase))
        return;
    Row& r = m_rows[row];
    if (phase == u"installed") {
        r.installed = true;
        touchRow(row);
    } else if (phase == u"signed-in") {
        r.installed = true;
        r.signedIn = true;
        r.identity = push.value("identity").toString().left(254);
        touchRow(row);
    }
    if (account != m_selected)
        return;
    const QString message = push.value("message").toString().left(500);
    if (phase == u"installing") {
        setPhase(u"installing"_s, message);
    } else if (phase == u"installed") {
        if (m_loginAfterInstall) {
            m_loginAfterInstall = false;
            setPhase(u"starting"_s);
            emit loginRequested(account);
        } else {
            setPhase(QString());
        }
    } else if (phase == u"awaiting-browser") {
        const QUrl url(push.value("url").toString(), QUrl::StrictMode);
        if (!url.isValid() || url.scheme() != u"https" || url.host().isEmpty())
            return setPhase(u"failed"_s, tr("%1 sent a sign-in address Jarvis can't open.").arg(label(account)));
        m_url = url.toString();
        m_code = push.value("code").toString().left(16);
        setPhase(u"awaiting-browser"_s);
    } else if (phase == u"signed-in") {
        setPhase(u"signed-in"_s);
        emit signedIn(account);
    } else if (phase == u"failed") {
        m_loginAfterInstall = false;
        setPhase(u"failed"_s, message);
    }
}

void AccountsModel::applyRequestError(const QString& account, const QString& text)
{
    if (account != m_selected)
        return;
    m_loginAfterInstall = false;
    setPhase(u"failed"_s, text);
}

void AccountsModel::signIn()
{
    if (busy() || selectedSignedIn())
        return;
    if (!selectedInstalled()) {
        m_loginAfterInstall = true;
        setPhase(u"installing"_s, tr("Getting %1 ready…").arg(label(m_selected)));
        emit installRequested(m_selected);
        return;
    }
    setPhase(u"starting"_s);
    emit loginRequested(m_selected);
}

void AccountsModel::signOut(const QString& account)
{
    if (!isAccount(account))
        return;
    if (account == m_selected) {
        m_loginAfterInstall = false;
        QString guidance;
        if (account == u"gemini")
            guidance = tr("To revoke Google access after signing out, visit https://myaccount.google.com/connections.");
        else if (account == u"copilot")
            guidance = tr("To revoke GitHub Copilot access after signing out, visit https://github.com/settings/applications.");
        setPhase(QString(), guidance);
    }
    emit logoutRequested(account);
}

void AccountsModel::remove(const QString& account)
{
    if (!isAccount(account))
        return;
    if (account == m_selected) {
        m_loginAfterInstall = false;
        setPhase(QString());
    }
    emit uninstallRequested(account);
}

void AccountsModel::copyToClipboard(const QString& text) const
{
    if (auto* clipboard = QGuiApplication::clipboard())
        clipboard->setText(text);
}

void AccountsModel::openInBrowser() const
{
    const QUrl url(m_url, QUrl::StrictMode);
    if (url.isValid() && url.scheme() == u"https")
        QDesktopServices::openUrl(url);
}
