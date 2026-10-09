#include "models/CuSettingsModel.h"

#include <QHostAddress>
#include <QJsonArray>
#include <QUrl>

#include "models/ProviderModel.h"

using namespace Qt::StringLiterals;

namespace {
bool isLoopbackHost(const QString& host)
{
    if (host.compare(u"localhost"_s, Qt::CaseInsensitive) == 0)
        return true;
    const QHostAddress address(host);
    return !address.isNull() && address.isLoopback();
}
} // namespace

CuSettingsModel::CuSettingsModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

int CuSettingsModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_rows.size());
}

QVariant CuSettingsModel::data(const QModelIndex& index, int role) const
{
    if (!index.isValid() || index.row() >= m_rows.size())
        return {};
    const Row& row = m_rows.at(index.row());
    switch (role) {
    case IdRole: return row.id;
    case NameRole: return u"%1 · %2"_s.arg(row.model, ProviderModel::providerLabel(row.kind, row.baseUrl));
    case VisionRole: return row.vision;
    case EnabledRole: return row.enabled && row.vision;
    case ConsentedRole: return row.consented;
    case NeedsConsentRole: return screenshotsLeave(row);
    case ReasonRole: return row.vision ? QString() : tr("This model can't see images, so it can't use the screen.");
    case PrivacyRole:
        return screenshotsLeave(row) ? tr("Screenshots of the allowed windows go to %1.").arg(destination(row))
                                     : tr("Screenshots stay on this computer.");
    default: return {};
    }
}

QHash<int, QByteArray> CuSettingsModel::roleNames() const
{
    // "cuEnabled", not "enabled": a delegate's own `enabled` must stay Item.enabled.
    return {{IdRole, "providerId"}, {NameRole, "name"}, {VisionRole, "vision"}, {EnabledRole, "cuEnabled"},
            {ConsentedRole, "consented"}, {NeedsConsentRole, "needsConsent"}, {ReasonRole, "reason"},
            {PrivacyRole, "privacy"}};
}

bool CuSettingsModel::screenshotsLeave(const Row& row)
{
    return !isLoopbackHost(QUrl(row.baseUrl).host());
}

QString CuSettingsModel::destination(const Row& row) const
{
    return ProviderModel::providerMode(row.kind, row.baseUrl) == u"cloud"
               ? ProviderModel::providerLabel(row.kind, row.baseUrl)
               : tr("a computer on your network");
}

QString CuSettingsModel::consentProviderName() const
{
    const int row = rowOf(m_consentId);
    return row < 0 ? QString() : destination(m_rows.at(row));
}

QStringList CuSettingsModel::excludedApps() const
{
    // Contracts §1: jarvis-cu refuses all input while one of these has focus.
    return {tr("The Jarvis shell and Settings"), tr("Lock screen"), tr("Installer"),
            tr("Password prompts (polkit)"), tr("Terminals"), tr("Password fields in any app")};
}

int CuSettingsModel::rowOf(const QString& id) const
{
    if (id.isEmpty())
        return -1;
    for (qsizetype i = 0; i < m_rows.size(); ++i)
        if (m_rows.at(i).id == id)
            return int(i);
    return -1;
}

void CuSettingsModel::loadList(const QJsonObject& providerList)
{
    beginResetModel();
    m_rows.clear();
    for (const QJsonValue& value : providerList.value("providers").toArray()) {
        const QJsonObject o = value.toObject();
        Row row{o.value("id").toString(), o.value("kind").toString(), o.value("baseUrl").toString(),
                o.value("model").toString()};
        if (row.id.isEmpty() || row.kind.isEmpty() || row.id == u"backup") // M4 §6.12: backup is implicit
            continue;
        row.vision = o.value("vision").toBool(false);
        // Contracts §4.8: computerUse: {enabled, consentAt} on each provider entry.
        const QJsonObject cu = o.value("computerUse").toObject();
        row.enabled = cu.value("enabled").toBool(false);
        row.consented = !cu.value("consentAt").toString().isEmpty();
        m_rows.append(row);
    }
    endResetModel();
    if (rowOf(m_consentId) < 0)
        m_consentId.clear();
    m_known = true;
    emit changed();
}

void CuSettingsModel::setEnabled(int row, bool enabled)
{
    if (row < 0 || row >= m_rows.size() || m_busy)
        return;
    const Row& r = m_rows.at(row);
    if (enabled && !r.vision)
        return;
    if (enabled == (r.enabled && r.vision))
        return;
    m_note.clear();
    if (enabled && screenshotsLeave(r) && !r.consented) {
        m_consentId = r.id; // the dialog opens; nothing is sent yet
        emit changed();
        return;
    }
    m_busy = true;
    emit changed();
    emit setEnabledRequested(r.id, enabled);
}

void CuSettingsModel::acceptConsent()
{
    if (m_consentId.isEmpty() || m_busy)
        return;
    m_busy = true;
    emit changed();
    emit consentRequested(m_consentId);
}

void CuSettingsModel::declineConsent()
{
    if (m_consentId.isEmpty())
        return;
    m_consentId.clear();
    emit changed();
}

void CuSettingsModel::applyConsentResult(const QString& providerId, bool ok, const QString& code, const QString& text)
{
    m_busy = false;
    m_consentId.clear();
    const int row = rowOf(providerId);
    if (!ok || row < 0) {
        if (!ok)
            m_note = errorText(code, text);
        emit changed();
        return;
    }
    m_rows[row].consented = true;
    emit dataChanged(index(row), index(row));
    m_busy = true;
    emit changed();
    emit setEnabledRequested(providerId, true);
}

void CuSettingsModel::applyEnabledResult(const QString& providerId, bool enabled, bool ok, const QString& code,
                                         const QString& text)
{
    m_busy = false;
    const int row = rowOf(providerId);
    if (ok && row >= 0) {
        m_rows[row].enabled = enabled;
        emit dataChanged(index(row), index(row));
    }
    m_note = ok ? QString() : errorText(code, text);
    emit changed();
}

QString CuSettingsModel::errorText(const QString& code, const QString& text) const
{
    if (code == u"unsupported")
        return tr("This version of Jarvis can't use the screen yet.");
    return tr("Couldn't change computer use: %1").arg(text);
}
