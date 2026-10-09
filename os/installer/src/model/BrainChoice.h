#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>

// Brain step (design: "Jarvis's brain"): this computer (catalog models that
// fit, recommended first), cloud (key entered after first login), or a
// network server. Builds Choices.brain.
class BrainChoice : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by InstallerModel")
    Q_PROPERTY(QString kind READ kind WRITE setKind NOTIFY changed)
    Q_PROPERTY(QString modelId READ modelId WRITE setModelId NOTIFY changed)
    Q_PROPERTY(QVariantList models READ models NOTIFY changed)
    Q_PROPERTY(bool localAvailable READ localAvailable NOTIFY changed)
    Q_PROPERTY(QString localTitle READ localTitle NOTIFY changed)
    Q_PROPERTY(QString localDetail READ localDetail NOTIFY changed)
    Q_PROPERTY(QString ramText READ ramText NOTIFY changed)
    Q_PROPERTY(QString gpuText READ gpuText NOTIFY changed)
    Q_PROPERTY(QString freeText READ freeText NOTIFY changed)
    Q_PROPERTY(QString lanUrl READ lanUrl WRITE setLanUrl NOTIFY changed)
    Q_PROPERTY(QString lanModel READ lanModel WRITE setLanModel NOTIFY changed)
    Q_PROPERTY(QString selectedModelName READ selectedModelName NOTIFY changed)
    Q_PROPERTY(bool valid READ valid NOTIFY changed)
    Q_PROPERTY(QString blockText READ blockText NOTIFY changed)

public:
    explicit BrainChoice(QObject* parent = nullptr);

    void applyProbe(const QJsonObject& probe);
    void setTargetBytes(qint64 bytes);

    QString kind() const { return m_kind; }
    void setKind(const QString& kind);
    QString modelId() const { return m_modelId; }
    void setModelId(const QString& id);
    QVariantList models() const;
    bool localAvailable() const { return !m_fit.isEmpty(); }
    QString localTitle() const;
    QString localDetail() const;
    QString ramText() const;
    QString gpuText() const;
    QString freeText() const;
    QString lanUrl() const { return m_lanUrl; }
    void setLanUrl(const QString& url);
    QString lanModel() const { return m_lanModel; }
    void setLanModel(const QString& model);
    QString selectedModelName() const;
    bool valid() const { return blockText().isEmpty(); }
    QString blockText() const;
    QJsonObject toJson() const;

signals:
    void changed();

private:
    void refit();
    QJsonObject selected() const;

    QJsonObject m_probe;
    qint64 m_target = 0;
    QJsonArray m_fit;
    QString m_kind;
    bool m_kindChosen = false;
    QString m_modelId;
    QString m_lanUrl, m_lanModel;
};
