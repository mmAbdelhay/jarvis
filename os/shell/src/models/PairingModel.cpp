#include "models/PairingModel.h"

#include <QRegularExpression>

using namespace Qt::StringLiterals;

PairingModel::PairingModel(QObject* parent)
    : QObject(parent)
{
    m_timer.setInterval(1000);
    connect(&m_timer, &QTimer::timeout, this, &PairingModel::tick);
}

QString PairingModel::cleanName(const QString& name)
{
    QString out;
    bool pendingSpace = false;
    for (const QChar c : name) {
        if (out.size() > kMaxNameLength + 1)
            break;
        const QChar::Category category = c.category();
        if (c.isSpace() || category == QChar::Separator_Line || category == QChar::Separator_Paragraph) {
            pendingSpace = !out.isEmpty();
            continue;
        }
        if (category == QChar::Other_Control || category == QChar::Other_Format)
            continue; // NUL, ESC, bidi overrides, zero-width joiners
        if (pendingSpace) {
            out.append(u' ');
            pendingSpace = false;
        }
        out.append(c);
    }
    if (out.isEmpty())
        return tr("Unnamed device");
    if (out.size() > kMaxNameLength) {
        qsizetype cut = kMaxNameLength - 1;
        if (out.at(cut - 1).isHighSurrogate())
            --cut;
        out = out.left(cut) + u"…"_s;
    }
    return out;
}

bool PairingModel::validRequestId(const QString& id)
{
    static const QRegularExpression pattern(u"^[A-Za-z0-9_-]{1,64}$"_s);
    return pattern.match(id).hasMatch();
}

bool PairingModel::load(const QJsonObject& pending)
{
    const QString requestId = pending.value("requestId").toString();
    if (!validRequestId(requestId))
        return false;
    m_requestId = requestId;
    m_name = cleanName(pending.value("deviceName").toString());
    const QString address = pending.value("address").toString();
    m_address = address.isEmpty() ? QString() : cleanName(address);
    m_secondsLeft = kSeconds;
    m_timer.start();
    emit changed();
    return true;
}

void PairingModel::approve()
{
    if (!active() || m_locked)
        return;
    const QString id = m_requestId;
    close();
    emit answered(id, true);
}

void PairingModel::deny()
{
    if (!active())
        return;
    const QString id = m_requestId;
    close();
    emit answered(id, false);
}

void PairingModel::tick()
{
    if (!active())
        return;
    if (--m_secondsLeft <= 0)
        return close();
    emit changed();
}

void PairingModel::setLocked(bool locked)
{
    if (locked == m_locked)
        return;
    m_locked = locked;
    emit changed();
}

void PairingModel::close()
{
    m_timer.stop();
    if (!active())
        return;
    m_requestId.clear();
    m_address.clear();
    m_name.clear();
    m_secondsLeft = 0;
    emit changed();
}
