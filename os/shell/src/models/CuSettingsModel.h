#pragma once

#include <QAbstractListModel>
#include <QJsonObject>
#include <QStringList>
#include <QtQml/qqmlregistration.h>

// Settings → Computer use (Rafiq v1.1 design §2.2, §2.6; contracts §2): one
// switch per provider, off by default, only for providers with vision. A
// provider whose endpoint is not on this computer needs cu:consent first
// (once); jarvisd records it in the provider's computerUse.consentAt. The protected
// apps (contracts §1) are listed, never editable.
class CuSettingsModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(int count READ count NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(QString note READ note NOTIFY changed)
    Q_PROPERTY(QString consentProviderId READ consentProviderId NOTIFY changed)
    Q_PROPERTY(QString consentProviderName READ consentProviderName NOTIFY changed)
    Q_PROPERTY(QStringList excludedApps READ excludedApps NOTIFY changed)

public:
    enum Role {
        IdRole = Qt::UserRole + 1,
        NameRole,
        VisionRole,
        EnabledRole,
        ConsentedRole,
        NeedsConsentRole,
        ReasonRole,
        PrivacyRole
    };
    Q_ENUM(Role)

    explicit CuSettingsModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool known() const { return m_known; }
    int count() const { return int(m_rows.size()); }
    bool busy() const { return m_busy; }
    QString note() const { return m_note; }
    QString consentProviderId() const { return m_consentId; }
    QString consentProviderName() const;
    QStringList excludedApps() const;

    Q_INVOKABLE void loadList(const QJsonObject& providerList);
    Q_INVOKABLE void setEnabled(int row, bool enabled);
    Q_INVOKABLE void acceptConsent();
    Q_INVOKABLE void declineConsent();
    Q_INVOKABLE void applyConsentResult(const QString& providerId, bool ok, const QString& code, const QString& text);
    Q_INVOKABLE void applyEnabledResult(const QString& providerId, bool enabled, bool ok, const QString& code,
                                        const QString& text);

signals:
    void changed();
    void consentRequested(const QString& providerId);
    void setEnabledRequested(const QString& providerId, bool enabled);

private:
    struct Row {
        QString id, kind, baseUrl, model;
        bool vision = false;
        bool enabled = false;
        bool consented = false;
    };
    int rowOf(const QString& id) const;
    static bool screenshotsLeave(const Row& row);
    QString destination(const Row& row) const;
    QString errorText(const QString& code, const QString& text) const;

    QList<Row> m_rows;
    bool m_known = false;
    bool m_busy = false;
    QString m_note;
    QString m_consentId;
};
