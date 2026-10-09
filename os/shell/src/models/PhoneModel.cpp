#include "models/PhoneModel.h"

#include <QJsonArray>

#include "models/PairingModel.h"

using namespace Qt::StringLiterals;

PhoneModel::PhoneModel(QObject* parent)
    : QObject(parent)
{
}

void PhoneModel::clearMessages()
{
    m_error.clear();
    m_note.clear();
}

void PhoneModel::refresh()
{
    emit statusRequested();
}

void PhoneModel::setEnabled(bool enabled)
{
    clearMessages();
    emit changed();
    emit configureRequested(enabled);
}

void PhoneModel::setOwnerPassword(const QString& current, const QString& next)
{
    if (next.isEmpty())
        return;
    clearMessages();
    emit changed();
    emit ownerPasswordRequested(current, next);
}

void PhoneModel::openPairing()
{
    clearMessages();
    emit changed();
    emit pairingOpenRequested();
}

void PhoneModel::cancelPairing()
{
    m_pairingUri.clear();
    clearMessages();
    emit changed();
    emit pairingCancelRequested();
}

void PhoneModel::revoke(const QString& deviceId)
{
    if (deviceId.isEmpty())
        return;
    clearMessages();
    emit changed();
    emit revokeRequested(deviceId);
}

void PhoneModel::applyStatus(const QJsonObject& status)
{
    m_known = true;
    m_enabled = status.value("enabled").toBool(false);
    const QJsonObject listening = status.value("listening").toObject();
    if (listening.isEmpty()) {
        m_address.clear();
        m_fingerprint.clear();
    } else {
        m_address = u"%1:%2"_s.arg(listening.value("host").toString()).arg(listening.value("port").toInt());
        m_fingerprint = listening.value("fingerprint").toString();
    }
    m_pairing = status.value("pairing").toString(u"closed"_s);
    if (m_pairing != u"open")
        m_pairingUri.clear();
    m_hasOwnerPassword = status.value("hasOwnerPassword").toBool(false);
    m_problem = status.value("problem").toString();
    m_devices.clear();
    for (const QJsonValue& value : status.value("devices").toArray()) {
        const QJsonObject device = value.toObject();
        const QString id = device.value("id").toString();
        if (id.isEmpty())
            continue;
        m_devices.append(QVariantMap{{u"id"_s, id},
                                     {u"name"_s, PairingModel::cleanName(device.value("name").toString())},
                                     {u"connected"_s, device.value("connected").toBool(false)}});
    }
    emit changed();
}

void PhoneModel::applyPairingOpened(const QJsonObject& opened)
{
    m_pairingUri = opened.value("uri").toString();
    if (!m_pairingUri.isEmpty())
        m_pairing = u"open"_s;
    emit changed();
}

void PhoneModel::applyOwnerPasswordResult(const QJsonObject& result)
{
    if (result.value("ok").toBool(false)) {
        m_error.clear();
        m_note = tr("Owner password saved.");
        m_hasOwnerPassword = true;
    } else {
        m_note.clear();
        const QString code = result.value("code").toString();
        if (code == u"current-wrong")
            m_error = tr("The current owner password is wrong.");
        else if (code == u"current-required")
            m_error = tr("Enter the current owner password first.");
        else
            m_error = tr("Couldn't save the owner password.");
    }
    emit changed();
}

void PhoneModel::applyError(const QString& text)
{
    m_note.clear();
    m_error = text.isEmpty() ? tr("Something went wrong. Try again.") : text;
    emit changed();
}
