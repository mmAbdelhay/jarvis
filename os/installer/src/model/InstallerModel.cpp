#include "InstallerModel.h"

#include <QJsonArray>
#include <QVariantMap>

#include "InstallRules.h"
#include "Language.h"
#include "InstallerBackend.h"
#include "LiveKeyboard.h"
#include "PowerActions.h"

using namespace Qt::StringLiterals;
using namespace jarvis::installer;

InstallerModel::InstallerModel(InstallerBackend* backend, PowerActions* power, const QString& distroName,
                               const QString& systemLocale, const QByteArray& systemTimezone, QObject* parent)
    : QObject(parent)
    , m_backend(backend)
    , m_power(power)
    , m_distro(distroName)
    , m_locale(new LocaleChoice(systemLocale, systemTimezone, this))
    , m_disk(new DiskChoice(distroName, this))
    , m_account(new AccountChoice(this))
    , m_brain(new BrainChoice(this))
    , m_progress(new InstallProgress(this))
{
    connect(m_backend, &InstallerBackend::probed, this, &InstallerModel::onProbed);
    connect(m_backend, &InstallerBackend::planned, this, &InstallerModel::onPlanned);
    connect(m_backend, &InstallerBackend::refused, this, &InstallerModel::onRefused);
    connect(m_backend, &InstallerBackend::executeAccepted, this, &InstallerModel::onExecuteAccepted);
    connect(m_backend, &InstallerBackend::callFailed, this, &InstallerModel::onCallFailed);
    connect(m_backend, &InstallerBackend::progress, this, [this](const QString& id, int pct, const QString& detail) {
        if (m_executeSent)
            m_progress->applyProgress(id, pct, detail);
    });
    connect(m_backend, &InstallerBackend::modelProgress, this, [this](int pct, const QString& detail) {
        if (m_executeSent)
            m_progress->applyModelProgress(pct, detail);
    });
    connect(m_backend, &InstallerBackend::finished, this, [this](bool ok, const QString& step, const QString& message) {
        if (!m_executeSent)
            return;
        m_progress->finish(ok, step, message);
        if (ok)
            setStep(Done);
        emit stateChanged();
    });
    connect(m_power, &PowerActions::failed, this, [this](const QString& message) {
        m_error = tr("Couldn't restart: %1").arg(message);
        emit stateChanged();
    });

    connect(m_locale, &LocaleChoice::changed, this, &InstallerModel::followLocale);
    connect(m_disk, &DiskChoice::changed, this, [this] {
        m_brain->setTargetBytes(m_disk->targetBytes());
        m_account->setEncrypt(m_disk->encrypt());
        emit stateChanged();
    });
    for (QObject* choice : {static_cast<QObject*>(m_locale), static_cast<QObject*>(m_account),
                            static_cast<QObject*>(m_brain), static_cast<QObject*>(m_progress)})
        connect(choice, SIGNAL(changed()), this, SIGNAL(stateChanged()));
}

void InstallerModel::setLiveKeyboard(LiveKeyboard* live)
{
    if (m_liveKeyboard)
        disconnect(m_locale, &LocaleChoice::changed, this, &InstallerModel::applyLiveKeyboard);
    m_liveKeyboard = live;
    if (!live)
        return;
    connect(m_locale, &LocaleChoice::changed, this, &InstallerModel::applyLiveKeyboard);
    applyLiveKeyboard();
}

void InstallerModel::applyLiveKeyboard()
{
    // LocaleChoice::changed also fires for language, time zone and our own
    // setTypingKeyboard: only a new keyboard is applied.
    const QString keyboard = m_locale->keyboard();
    if (!m_liveKeyboard || keyboard == m_liveApplied)
        return;
    m_liveApplied = keyboard;
    if (m_liveKeyboard->apply(keyboard))
        m_locale->setTypingKeyboard(keyboard);
}

void InstallerModel::setDistroName(const QString& distro)
{
    if (distro.isEmpty() || distro == m_distro)
        return;
    m_distro = distro;
    m_disk->setDistroName(distro);
    emit languageChanged();
}

void InstallerModel::setLanguageApplier(LanguageApplier applier)
{
    m_languageApplier = std::move(applier);
    m_uiLanguage.clear(); // force the first apply
    followLocale();
}

void InstallerModel::followLocale()
{
    const QString code = jarvis::ui::languageForLocale(m_locale->language());
    if (code == m_uiLanguage || !m_languageApplier)
        return;
    if (!m_languageApplier(code)) {
        if (m_uiLanguage.isEmpty())
            m_uiLanguage = u"en"_s;
        return; // Arabic catalogs missing: the screens stay English
    }
    m_uiLanguage = code;
    retranslate();
}

// C++ text is built with tr() on read; tell QML to read it again.
void InstallerModel::retranslate()
{
    emit languageChanged();
    emit stateChanged();
    emit planChanged();
    emit m_locale->changed();
    emit m_disk->changed();
    emit m_account->changed();
    emit m_brain->changed();
    emit m_progress->changed();
}

QStringList InstallerModel::stepLabels() const
{
    return {tr("Welcome"), tr("Disk"), tr("Your account"), tr("Jarvis's brain"), tr("Review"), tr("Installing"), tr("Done")};
}

bool InstallerModel::canContinue() const
{
    if (busy())
        return false;
    switch (m_step) {
    case Welcome: return m_probed && m_uefi;
    case Disk: return m_disk->valid();
    case Account: return m_account->valid();
    case Brain: return m_brain->valid();
    case Review: return !m_planId.isEmpty();
    case Installing: return m_progress->failed();
    case Done: return true;
    }
    return false;
}

QString InstallerModel::blockText() const
{
    if (busy())
        return {};
    switch (m_step) {
    case Welcome:
        if (!m_probed)
            return m_error.isEmpty() ? tr("Looking at this computer…") : QString();
        return m_uefi ? QString() : jarvis::installer::refusalText(u"no-uefi"_s, {}, m_distro);
    case Disk: return m_disk->blockText();
    case Account: return m_account->blockText();
    case Brain: return m_brain->blockText();
    default: return {};
    }
}

QString InstallerModel::nextLabel() const
{
    switch (m_step) {
    case Brain: return m_call == Call::Plan ? tr("Checking…") : tr("Continue");
    case Review: return m_call == Call::Execute ? tr("Starting…") : tr("Install");
    case Installing: return m_progress->failed() ? tr("Restart now") : tr("Next");
    case Done: return tr("Restart now");
    default: return tr("Continue");
    }
}

QJsonObject InstallerModel::choices() const
{
    return {{"locale", m_locale->language()}, {"keyboard", m_locale->keyboard()}, {"timezone", m_locale->timezone()},
            {"disk", m_disk->toJson()}, {"encrypt", m_disk->encrypt()},
            {"user", m_account->toJson()}, {"brain", m_brain->toJson()}};
}

void InstallerModel::setStep(int step)
{
    if (step == m_step)
        return;
    if (m_step == Review && step < Review)
        clearPlan(); // Back from Review changes nothing and forgets the plan
    m_step = step;
    emit stepChanged();
    emit stateChanged();
}

void InstallerModel::clearNotices()
{
    m_refusal.clear();
    m_error.clear();
}

void InstallerModel::clearPlan()
{
    m_planId.clear();
    m_summary.clear();
    m_warnings.clear();
    m_diskAfter.clear();
    emit planChanged();
}

void InstallerModel::start()
{
    if (busy() || m_probed)
        return;
    m_error.clear();
    m_call = Call::Probe;
    emit stateChanged();
    m_backend->probe();
}

void InstallerModel::next()
{
    if (!canContinue())
        return;
    switch (m_step) {
    case Welcome:
    case Disk:
    case Account:
        clearNotices();
        setStep(m_step + 1);
        return;
    case Brain:
        clearNotices();
        m_call = Call::Plan;
        emit stateChanged();
        m_backend->plan(choices());
        return;
    case Review: {
        clearNotices();
        m_call = Call::Execute;
        m_executeSent = true;
        emit stateChanged();
        m_backend->execute(m_planId, m_account->secretsJson());
        return;
    }
    case Installing:
    case Done:
        m_power->reboot();
        return;
    }
}

void InstallerModel::back()
{
    if (!backVisible())
        return;
    clearNotices();
    setStep(m_step - 1);
}

void InstallerModel::goTo(int step)
{
    if (busy() || step < Welcome || step >= m_step || m_step > Review)
        return;
    clearNotices();
    setStep(step);
}

void InstallerModel::onProbed(const QJsonObject& result)
{
    if (m_call != Call::Probe)
        return;
    m_call = Call::None;
    m_probed = true;
    m_uefi = result.value("uefi").toBool();
    m_locale->applyProbe(result);
    m_brain->applyProbe(result);
    m_disk->applyProbe(result); // → DiskChoice::changed → brain target, account encrypt
    emit stateChanged();
}

void InstallerModel::onPlanned(const QJsonObject& plan)
{
    if (m_call != Call::Plan)
        return;
    m_call = Call::None;
    m_planId = plan.value("planId").toString();
    if (m_planId.isEmpty()) {
        m_error = tr("The installer's helper answered without a plan. Try again.");
        emit stateChanged();
        return;
    }
    m_summary.clear();
    for (const QJsonValue& line : plan.value("summary").toArray())
        m_summary.append(line.toString());
    m_warnings.clear();
    for (const QJsonValue& line : plan.value("warnings").toArray())
        m_warnings.append(line.toString());
    m_diskAfter.clear();
    double total = 0;
    for (const QJsonValue& part : plan.value("diskAfter").toArray())
        total += part.toObject().value("sizeBytes").toDouble();
    for (const QJsonValue& value : plan.value("diskAfter").toArray()) {
        const QJsonObject part = value.toObject();
        const double size = part.value("sizeBytes").toDouble();
        m_diskAfter.append(QVariantMap{{u"label"_s, part.value("label").toString()},
                                       {u"sizeText"_s, formatSize(qint64(size))},
                                       {u"fraction"_s, total > 0 ? size / total : 0.0},
                                       {u"encrypted"_s, part.value("encrypted").toBool()}});
    }
    m_progress->setPlanSteps(plan.value("steps").toArray());
    emit planChanged();
    setStep(Review);
}

void InstallerModel::onRefused(const QString& key, const QString& message)
{
    if (m_call != Call::Plan)
        return;
    m_call = Call::None;
    static const QStringList diskKeys{u"live-medium"_s, u"disk-too-small"_s, u"ntfs-bitlocker"_s, u"ntfs-hibernated"_s, u"ntfs-dirty"_s,
                                      u"alongside-too-small"_s, u"alongside-no-windows"_s, u"manual-missing-root"_s, u"manual-missing-esp"_s};
    if (key == u"no-uefi")
        setStep(Welcome);
    else if (diskKeys.contains(key))
        setStep(Disk);
    m_refusal = jarvis::installer::refusalText(key, message, m_distro);
    emit stateChanged();
}

void InstallerModel::onExecuteAccepted()
{
    if (m_call != Call::Execute)
        return;
    m_call = Call::None;
    m_account->wipe();
    setStep(Installing);
}

void InstallerModel::onCallFailed(const QString& method, const QString& message)
{
    const Call was = m_call;
    if (was == Call::None)
        return;
    m_call = Call::None;
    if (was == Call::Probe)
        m_error = tr("Couldn't look at this computer's disks: %1").arg(message);
    else if (was == Call::Plan)
        m_error = tr("The installer's helper didn't answer (%1). Try again.").arg(message);
    else {
        m_executeSent = false;
        m_error = tr("The installation didn't start (%1). Try again.").arg(message);
    }
    Q_UNUSED(method)
    emit stateChanged();
}
