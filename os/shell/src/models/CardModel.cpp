#include "models/CardModel.h"
#include "models/SettingChange.h"

#include <QDateTime>
#include <QJsonArray>
#include <QSet>
#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace {
const QSet<QString> kSources{u"debian"_s, u"flathub"_s, u"system"_s, u"network"_s};

QString labelForSource(const QString& source)
{
    if (source == u"debian")
        return u"Debian"_s;
    if (source == u"flathub")
        return u"Flathub"_s;
    return source;
}
} // namespace

CardModel::CardModel(QObject* parent)
    : QAbstractListModel(parent)
    , m_now([] { return QDateTime::currentMSecsSinceEpoch(); })
{
    m_timer.setInterval(1000);
    connect(&m_timer, &QTimer::timeout, this, &CardModel::tick);
}

CardModel::~CardModel()
{
    wipeSecrets();
}

int CardModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_items.size());
}

QVariant CardModel::data(const QModelIndex& index, int role) const
{
    if (!checkIndex(index, CheckIndexOption::IndexIsValid | CheckIndexOption::ParentIsInvalid))
        return {};
    const Item& item = m_items.at(index.row());
    switch (role) {
    case ItemIdRole: return item.itemId;
    case ToolRole: return item.tool;
    case Qt::DisplayRole:
    case TitleRole: return item.title;
    case DetailRole: return item.detail;
    case SourceRole: return item.source;
    case SourceLabelRole: return labelForSource(item.source);
    case RiskRole: return item.risk;
    case TickedRole: return item.ticked;
    case SecretFieldsRole: return item.secretFields;
    case ChangeFromRole:
    case ChangeToRole: {
        const auto change = settingChange(item.tool, item.detail);
        return change ? (role == ChangeFromRole ? change->first : change->second) : QString();
    }
    default: return {};
    }
}

QHash<int, QByteArray> CardModel::roleNames() const
{
    return {{ItemIdRole, "itemId"}, {ToolRole, "tool"}, {TitleRole, "title"}, {DetailRole, "detail"},
            {SourceRole, "source"}, {SourceLabelRole, "sourceLabel"}, {RiskRole, "risk"},
            {TickedRole, "ticked"}, {SecretFieldsRole, "secretFields"}, {ChangeFromRole, "changeFrom"}, {ChangeToRole, "changeTo"}};
}

int CardModel::tickedCount() const
{
    return int(std::count_if(m_items.cbegin(), m_items.cend(), [](const Item& i) { return i.ticked; }));
}

QString CardModel::headline() const
{
    if (m_items.isEmpty())
        return {};
    if (m_exclusive)
        return u"Connect to a network"_s;
    if (m_items.size() == 1)
        return u"Jarvis needs your approval"_s;
    return u"Jarvis wants to do %1 things"_s.arg(m_items.size());
}

QString CardModel::approveLabel() const
{
    const int count = itemCount();
    const int ticked = tickedCount();
    if (m_exclusive)
        return u"Connect"_s;
    if (count <= 1)
        return u"Approve"_s;
    if (ticked == count)
        return u"Approve all %1"_s.arg(count);
    return u"Approve %1 of %2"_s.arg(ticked).arg(count);
}

bool CardModel::canApprove() const
{
    return active() && !expired() && !m_locked && tickedCount() > 0;
}

void CardModel::setLocked(bool locked)
{
    if (locked == m_locked)
        return;
    m_locked = locked;
    emit changed();
}

bool CardModel::voiceAnswerable() const
{
    // Design §3.2 ruling: voice may answer only a plain confirm card on an
    // unlocked screen. Secrets and password-tier items need hands and eyes.
    if (!active() || expired() || m_locked || m_exclusive)
        return false;
    return std::none_of(m_items.cbegin(), m_items.cend(), [](const Item& i) {
        return i.risk == u"password" || !i.secretFields.isEmpty();
    });
}

QString CardModel::countdownText() const
{
    if (!active() || m_secondsLeft < 0)
        return {};
    if (expired())
        return u"Timed out"_s;
    return u"Auto-deny in %1:%2"_s.arg(m_secondsLeft / 60).arg(m_secondsLeft % 60, 2, 10, QChar(u'0'));
}

bool CardModel::load(const QJsonObject& card)
{
    const QString cardId = card.value("cardId").toString();
    // A re-push of the card already shown (contracts §6.7) keeps the user's
    // ticks and typed secrets.
    if (!cardId.isEmpty() && cardId == m_cardId)
        return true;
    const QJsonArray items = card.value("items").toArray();
    if (cardId.isEmpty() || items.isEmpty() || !card.value("expiresAt").isDouble())
        return false;
    QList<Item> parsed;
    QSet<QString> seen;
    for (const QJsonValue& value : items) {
        const QJsonObject o = value.toObject();
        Item item;
        item.itemId = o.value("itemId").toString();
        if (item.itemId.isEmpty() || seen.contains(item.itemId))
            return false;
        seen.insert(item.itemId);
        item.tool = o.value("tool").toString();
        item.title = o.value("title").toString();
        item.detail = o.value("detail").toString();
        const QString source = o.value("source").toString();
        item.source = kSources.contains(source) ? source : u"system"_s;
        item.risk = o.value("risk").toString() == u"password" ? u"password"_s : u"confirm"_s;
        for (const QJsonValue& field : o.value("secretFields").toArray()) {
            const QString name = field.toObject().value("name").toString();
            if (name.isEmpty())
                continue;
            const QString label = field.toObject().value("label").toString();
            item.secretFields.append(QVariantMap{{u"name"_s, name}, {u"label"_s, label.isEmpty() ? name : label}});
        }
        parsed.append(item);
    }
    // contracts §6.9: the Wi-Fi pick card has one net.wifi_connect item per
    // network (even if there is only one) and starts with none ticked.
    const bool exclusive = std::all_of(parsed.cbegin(), parsed.cend(), [](const Item& i) { return i.tool == u"net.wifi_connect"; });
    for (Item& item : parsed)
        item.ticked = !exclusive;

    wipeSecrets();
    beginResetModel();
    m_items = parsed;
    m_cardId = cardId;
    m_turnId = card.value("turnId").toString(); // null → ""
    m_expiresAt = qint64(card.value("expiresAt").toDouble());
    m_exclusive = exclusive;
    m_source = card;
    m_secondsLeft = -1;
    endResetModel();
    m_timer.start();
    tick();
    emit changed();
    return true;
}

void CardModel::setTicked(int row, bool ticked)
{
    if (row < 0 || row >= m_items.size())
        return;
    if (m_items[row].ticked == ticked)
        return;
    m_items[row].ticked = ticked;
    // An unticked item forgets what was typed for it, so ticking it again
    // cannot resend a stale secret (e.g. a Wi-Fi password).
    if (!ticked)
        wipeSecrets(m_items[row]);
    if (m_exclusive && ticked)
        for (int other = 0; other < m_items.size(); ++other)
            if (other != row && m_items[other].ticked) {
                m_items[other].ticked = false;
                wipeSecrets(m_items[other]);
            }
    emit dataChanged(index(0), index(int(m_items.size()) - 1), {TickedRole});
    emit changed();
}

void CardModel::toggle(int row)
{
    if (row >= 0 && row < m_items.size())
        setTicked(row, !m_items[row].ticked);
}

void CardModel::setSecret(int row, const QString& field, const QString& value)
{
    if (row < 0 || row >= m_items.size() || !m_items[row].ticked)
        return;
    const QVariantList& fields = m_items[row].secretFields;
    const bool declared = std::any_of(fields.cbegin(), fields.cend(),
                                      [&](const QVariant& f) { return f.toMap().value(u"name"_s).toString() == field; });
    if (declared)
        m_items[row].secrets.insert(field, value);
}

QJsonObject CardModel::decision(bool approve) const
{
    const bool runs = approve && canApprove();
    QJsonArray ticked;
    QJsonObject secrets;
    if (runs) {
        for (const Item& item : m_items) {
            if (!item.ticked)
                continue;
            ticked.append(item.itemId);
            QJsonObject fields;
            for (const QVariant& field : item.secretFields) {
                const QString name = field.toMap().value(u"name"_s).toString();
                const auto it = item.secrets.constFind(name);
                if (it != item.secrets.cend() && !it->isEmpty())
                    fields.insert(name, *it);
            }
            if (!fields.isEmpty())
                secrets.insert(item.itemId, fields);
        }
    }
    return {{"cardId", m_cardId}, {"approve", runs}, {"ticked", ticked}, {"secrets", secrets}};
}

void CardModel::setAllTicked(bool ticked)
{
    if (m_exclusive || m_items.isEmpty())
        return; // pick-one cards (Wi-Fi) tick exactly one, never all
    bool any = false;
    for (Item& item : m_items) {
        if (item.ticked == ticked)
            continue;
        item.ticked = ticked;
        if (!ticked)
            wipeSecrets(item);
        any = true;
    }
    if (!any)
        return;
    emit dataChanged(index(0), index(int(m_items.size()) - 1), {TickedRole});
    emit changed();
}

void CardModel::wipeSecrets(Item& item)
{
    for (auto it = item.secrets.begin(); it != item.secrets.end(); ++it)
        it->fill(QChar(u'\0'));
    item.secrets.clear();
}

void CardModel::wipeSecrets()
{
    for (Item& item : m_items)
        wipeSecrets(item);
}

void CardModel::close()
{
    wipeSecrets();
    m_timer.stop();
    beginResetModel();
    m_items.clear();
    m_cardId.clear();
    m_turnId.clear();
    m_expiresAt = 0;
    m_secondsLeft = -1;
    m_exclusive = false;
    m_source = QJsonObject();
    endResetModel();
    emit changed();
}

void CardModel::tick()
{
    if (!active())
        return;
    const qint64 remaining = m_expiresAt - m_now();
    const int seconds = remaining <= 0 ? 0 : int(std::ceil(double(remaining) / 1000.0));
    if (seconds != m_secondsLeft) {
        m_secondsLeft = seconds;
        emit changed();
    }
    if (seconds == 0)
        m_timer.stop();
}

void CardModel::setClockForTest(double nowMs)
{
    const qint64 fixed = qint64(nowMs);
    m_now = [fixed] { return fixed; };
    tick();
}
