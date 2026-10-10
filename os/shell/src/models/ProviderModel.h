#pragma once

#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QtQml/qqmlregistration.h>

// The provider shown in the top bar and edited by first-boot setup and
// Settings (contracts §3.1 provider:list|probe|save). Holds the draft and
// the probe state; asks for I/O through probeRequested/saveRequested. The API
// key lives here only until a successful save, then it is wiped.
class ProviderModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY activeChanged)
    Q_PROPERTY(bool hasActive READ hasActive NOTIFY activeChanged)
    Q_PROPERTY(QString activeKind READ activeKind NOTIFY activeChanged)
    Q_PROPERTY(QString activeModel READ activeModel NOTIFY activeChanged)
    Q_PROPERTY(QString activeLabel READ activeLabel NOTIFY activeChanged)
    Q_PROPERTY(bool activeHasKey READ activeHasKey NOTIFY activeChanged)
    Q_PROPERTY(QString activeId READ activeId NOTIFY activeChanged)
    Q_PROPERTY(QString editingId READ editingId NOTIFY draftChanged)
    Q_PROPERTY(QString account READ account WRITE setAccount NOTIFY draftChanged)
    Q_PROPERTY(QString mode READ mode WRITE setMode NOTIFY draftChanged)
    Q_PROPERTY(QString preset READ preset WRITE setPreset NOTIFY draftChanged)
    Q_PROPERTY(QString kind READ kind WRITE setKind NOTIFY draftChanged)
    Q_PROPERTY(QString baseUrl READ baseUrl WRITE setBaseUrl NOTIFY draftChanged)
    Q_PROPERTY(QString model READ model WRITE setModel NOTIFY draftChanged)
    Q_PROPERTY(QString apiKey READ apiKey WRITE setApiKey NOTIFY draftChanged)
    Q_PROPERTY(bool needsKey READ needsKey NOTIFY draftChanged)
    Q_PROPERTY(QString privacyText READ privacyText NOTIFY draftChanged)
    Q_PROPERTY(QStringList presetNames READ presetNames CONSTANT)
    Q_PROPERTY(QStringList models READ models NOTIFY probeChanged)
    Q_PROPERTY(QString probeState READ probeState NOTIFY probeChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY probeChanged)
    Q_PROPERTY(bool canSave READ canSave NOTIFY probeChanged)

public:
    explicit ProviderModel(QObject* parent = nullptr);
    ~ProviderModel() override;

    bool known() const { return m_known; }
    bool hasActive() const { return m_hasActive; }
    QString activeKind() const { return m_activeKind; }
    QString activeModel() const { return m_activeModel; }
    QString activeLabel() const;
    bool activeHasKey() const { return m_activeHasKey; }
    QString activeId() const { return m_activeId; }
    QString editingId() const { return m_editingId; }
    QString suggestedId() const; // a provider id for a new draft: local, lan, or the preset in lower case

    // Shared with ProviderListModel: where a provider runs, and how the top bar names it.
    static QString providerMode(const QString& kind, const QString& url);
    static QString providerLabel(const QString& kind, const QString& url);

    QString account() const { return m_account; }
    QString mode() const { return m_mode; }
    QString preset() const { return m_preset; }
    QString kind() const { return m_kind; }
    QString baseUrl() const { return m_baseUrl; }
    QString model() const { return m_model; }
    QString apiKey() const { return m_apiKey; }
    void setAccount(const QString& account);
    void setMode(const QString& mode);
    void setPreset(const QString& name);
    void setKind(const QString& kind);
    void setBaseUrl(const QString& url);
    void setModel(const QString& model);
    void setApiKey(const QString& key);

    bool needsKey() const { return m_mode == u"cloud"; }
    QString privacyText() const;
    QStringList presetNames() const;
    QStringList models() const { return m_models; }
    QString probeState() const { return m_probeState; }
    QString statusText() const;
    bool canSave() const;

    Q_INVOKABLE void loadList(const QJsonObject& list);
    Q_INVOKABLE void editActive();
    Q_INVOKABLE void editProvider(const QJsonObject& config); // {id, kind, baseUrl, model, hasKey}
    Q_INVOKABLE void startNew();
    void loadActive(const QJsonObject& config);
    Q_INVOKABLE void probe();
    Q_INVOKABLE void save();
    Q_INVOKABLE void applyProbeResult(const QJsonObject& result);
    Q_INVOKABLE void applySaveResult(const QJsonObject& result);
    Q_INVOKABLE void applyRequestError(const QString& text);
    QJsonObject draft() const;
    QJsonObject probeDraft() const;

signals:
    void activeChanged();
    void draftChanged();
    void probeChanged();
    void probeRequested(const QJsonObject& draft);
    void saveRequested(const QJsonObject& draft);
    void saved();

private:
    void resetProbe();
    void fail(const QString& message);
    void wipeKey();
    QString displayName() const;
    bool keepsSavedKey() const;
    void loadDraft(const QJsonObject& config);

    bool m_known = false;
    bool m_hasActive = false;
    QString m_activeKind, m_activeBaseUrl, m_activeModel;
    bool m_activeHasKey = false;
    QString m_activeId;
    QString m_editingId, m_editingKind, m_editingBaseUrl;
    bool m_editingHasKey = false;

    QString m_account;
    QString m_mode, m_preset, m_kind, m_baseUrl, m_model, m_apiKey;
    QStringList m_models;
    QString m_probeState = QStringLiteral("idle");
    QString m_error;
    bool m_supportsTools = false;
    bool m_autoProbed = false;
};
