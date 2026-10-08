#include "core/LockLauncher.h"

LockLauncher::LockLauncher(QString program, QStringList arguments, QObject* parent)
    : QObject(parent)
    , m_program(std::move(program))
    , m_arguments(std::move(arguments))
{
    m_process.setProcessChannelMode(QProcess::ForwardedErrorChannel); // its stderr goes to our journal
    connect(&m_process, &QProcess::readyReadStandardOutput, this, &LockLauncher::onReadyRead);
    connect(&m_process, &QProcess::finished, this, [this](int code, QProcess::ExitStatus status) {
        emit exited(code, status == QProcess::CrashExit);
    });
    connect(&m_process, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (error == QProcess::FailedToStart)
            emit exited(127, false);
    });
}

void LockLauncher::launch()
{
    if (running())
        return;
    m_buffer.clear();
    m_process.start(m_program, m_arguments, QIODevice::ReadOnly);
}

void LockLauncher::onReadyRead()
{
    m_buffer += m_process.readAllStandardOutput();
    qsizetype newline;
    while ((newline = m_buffer.indexOf('\n')) >= 0) {
        const QByteArray line = m_buffer.left(newline).trimmed();
        m_buffer.remove(0, newline + 1);
        if (line == "locked")
            emit confirmed();
    }
    if (m_buffer.size() > 4096)
        m_buffer.clear(); // a locker never writes long lines
}
