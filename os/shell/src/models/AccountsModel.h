#pragma once

#include <QAbstractListModel>
#include <QJsonObject>
#include <QStringList>
#include <QtQml/qqmlregistration.h>

// Plan Y §2.4, §2.5: the four sign-in accounts as the shell shows them.
// account:status fills the rows; account:state pushes drive the selected
// account (installing → installed → awaiting-browser (URL, code) → signed-in,
// or failed). "Sign in" on an account that is not set up installs it first
// and then starts the sign-in on its own. I/O goes out through signals.
class AccountsModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(QString selected READ selected WRITE setSelected NOTIFY changed)
    Q_PROPERTY(QString selectedLabel READ selectedLabel NOTIFY changed)
    Q_PROPERTY(bool selectedInstalled READ selectedInstalled NOTIFY changed)
    Q_PROPERTY(bool selectedSignedIn READ selectedSignedIn NOTIFY changed)
    Q_PROPERTY(QString selectedIdentity READ selectedIdentity NOTIFY changed)
    Q_PROPERTY(QString phase READ phase NOTIFY changed)
    Q_PROPERTY(QString message READ message NOTIFY changed)
    Q_PROPERTY(QString url READ url NOTIFY changed)
    Q_PROPERTY(QString code READ code NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(QString statusLine READ statusLine NOTIFY changed)

public:
    enum Role { AccountRole = Qt::UserRole + 1, LabelRole, InstalledRole, VersionRole, SignedInRole, IdentityRole, StatusTextRole };
    Q_ENUM(Role)

    explicit AccountsModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    static const QStringList& ids();
    static bool isAccount(const QString& account);
    static QString label(const QString& account);
    static QString displayUrl(const QString& account);
    static QString accountForUrl(const QString& baseUrl);

    bool known() const { return m_known; }
    QString selected() const { return m_selected; }
    void setSelected(const QString& account);
    QString selectedLabel() const { return label(m_selected); }
    bool selectedInstalled() const;
    bool selectedSignedIn() const;
    QString selectedIdentity() const;
    QString phase() const { return m_phase; }
    QString message() const { return m_message; }
    QString url() const { return m_url; }
    QString code() const { return m_code; }
    bool busy() const;
    QString statusLine() const;

    Q_INVOKABLE QString labelFor(const QString& account) const { return label(account); }
    Q_INVOKABLE void applyStatus(const QJsonObject& result);
    Q_INVOKABLE void applyState(const QJsonObject& push);
    Q_INVOKABLE void applyRequestError(const QString& account, const QString& text);
    Q_INVOKABLE void signIn();
    Q_INVOKABLE void signOut(const QString& account);
    Q_INVOKABLE void remove(const QString& account);
    Q_INVOKABLE void refresh() { emit statusRequested(); }
    Q_INVOKABLE void copyToClipboard(const QString& text) const;
    Q_INVOKABLE void openInBrowser() const;

signals:
    void changed();
    void statusRequested();
    void installRequested(const QString& account);
    void loginRequested(const QString& account);
    void logoutRequested(const QString& account);
    void uninstallRequested(const QString& account);
    void signedIn(const QString& account);

private:
    struct Row {
        QString account;
        bool installed = false;
        QString version;
        bool signedIn = false;
        QString identity;
    };
    int rowOf(const QString& account) const;
    void touchRow(int row);
    void setPhase(const QString& phase, const QString& message = {});
    QString statusTextOf(const Row& row) const;

    QList<Row> m_rows;
    bool m_known = false;
    QString m_selected = QStringLiteral("claude");
    QString m_phase, m_message, m_url, m_code;
    bool m_loginAfterInstall = false;
};
