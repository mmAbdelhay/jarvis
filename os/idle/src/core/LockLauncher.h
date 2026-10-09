#pragma once

#include <QObject>
#include <QProcess>
#include <QStringList>

// Runs jarvis-lock and reports what it does: confirmed() on its "locked"
// stdout line, exited(code, crashed) when it ends; 127 = could not start.
class LockLauncher : public QObject {
    Q_OBJECT
public:
    explicit LockLauncher(QString program = QStringLiteral("/usr/bin/jarvis-lock"), QStringList arguments = {},
                          QObject* parent = nullptr);
    bool running() const { return m_process.state() != QProcess::NotRunning; }

public slots:
    void launch();

signals:
    void confirmed();
    void exited(int exitCode, bool crashed);

private:
    void onReadyRead();

    QString m_program;
    QStringList m_arguments;
    QProcess m_process;
    QByteArray m_buffer;
};
