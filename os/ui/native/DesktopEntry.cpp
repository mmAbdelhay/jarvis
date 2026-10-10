#include "DesktopEntry.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QSet>
#include <QStringDecoder>

using namespace Qt::StringLiterals;

namespace jarvis::ui {

namespace {
constexpr qint64 kMaxBytes = 64 * 1024;

QString localized(const QHash<QString, QString>& values, const QString& lang)
{
    if (!lang.isEmpty()) {
        if (values.contains(lang))
            return values.value(lang);
        QStringList keys = values.keys();
        keys.sort();
        for (const QString& key : std::as_const(keys))
            if (key.startsWith(lang + u'_'))
                return values.value(key);
    }
    return values.value(QString());
}

// General string-value escapes (spec "Possible value types"): \s \n \t \r \\.
// Any other backslash pair is kept for splitExec's quoting rules.
QString unescapeValue(QStringView value)
{
    QString out;
    out.reserve(value.size());
    for (qsizetype i = 0; i < value.size(); ++i) {
        if (value[i] != u'\\' || i + 1 >= value.size()) {
            out += value[i];
            continue;
        }
        const QChar next = value[i + 1];
        if (next == u's') { out += u' '; ++i; }
        else if (next == u'n') { out += u'\n'; ++i; }
        else if (next == u't') { out += u'\t'; ++i; }
        else if (next == u'r') { out += u'\r'; ++i; }
        else if (next == u'\\') { out += u'\\'; ++i; }
        else out += value[i];
    }
    return out;
}

QStringList splitList(const QString& value)
{
    QStringList out;
    for (const QString& part : value.split(u';', Qt::SkipEmptyParts))
        if (const QString t = part.trimmed(); !t.isEmpty())
            out << t;
    return out;
}
} // namespace

QString DesktopEntry::name(const QString& lang) const { return localized(names, lang); }
QString DesktopEntry::comment(const QString& lang) const { return localized(comments, lang); }

std::optional<DesktopEntry> parseDesktopEntry(const QString& path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return std::nullopt;
    const QByteArray bytes = file.read(kMaxBytes + 1);
    if (bytes.size() > kMaxBytes)
        return std::nullopt;
    QStringDecoder decoder(QStringDecoder::Utf8);
    const QString text = decoder.decode(bytes);
    if (decoder.hasError())
        return std::nullopt;

    static const QRegularExpression keyPattern(u"^([A-Za-z0-9-]+)(?:\\[([A-Za-z_@.]+)\\])?$"_s);
    DesktopEntry entry;
    entry.path = path;
    entry.id = QFileInfo(path).completeBaseName();
    bool inMain = false;
    bool sawMain = false;
    for (QStringView line : QStringView(text).split(u'\n')) {
        line = line.trimmed();
        if (line.isEmpty() || line.startsWith(u'#'))
            continue;
        if (line.startsWith(u'[')) {
            inMain = line == u"[Desktop Entry]";
            sawMain = sawMain || inMain;
            continue;
        }
        if (!inMain)
            continue;
        const qsizetype eq = line.indexOf(u'=');
        if (eq <= 0)
            continue;
        const QString keyText = line.left(eq).trimmed().toString();
        const QRegularExpressionMatch m = keyPattern.match(keyText);
        if (!m.hasMatch())
            continue;
        const QString key = m.captured(1);
        const QString locale = m.captured(2);
        const QString value = unescapeValue(line.mid(eq + 1).trimmed());
        if (key == u"Name")
            entry.names.insert(locale, value);
        else if (key == u"Comment")
            entry.comments.insert(locale, value);
        else if (!locale.isEmpty())
            continue;
        else if (key == u"Type")
            entry.type = value;
        else if (key == u"Exec")
            entry.exec = value;
        else if (key == u"TryExec")
            entry.tryExec = value;
        else if (key == u"Icon")
            entry.icon = value;
        else if (key == u"Categories")
            entry.categories = splitList(value);
        else if (key == u"OnlyShowIn")
            entry.onlyShowIn = splitList(value);
        else if (key == u"NotShowIn")
            entry.notShowIn = splitList(value);
        else if (key == u"NoDisplay")
            entry.noDisplay = value == u"true";
        else if (key == u"Hidden")
            entry.hidden = value == u"true";
        else if (key == u"Terminal")
            entry.terminal = value == u"true";
    }
    if (sawMain && entry.hidden)
        return entry; // a tombstone: Hidden=true deletes the id, even without Name/Exec
    if (!sawMain || entry.names.value(QString()).trimmed().isEmpty() || entry.exec.trimmed().isEmpty())
        return std::nullopt;
    return entry;
}

std::optional<QStringList> splitExec(const QString& exec)
{
    static const QString kShell = u";|&<>`$()"_s;
    static const QString kCodes = u"fFuUdDnNickvm"_s;
    QStringList args;
    QString current;
    bool haveArg = false;
    bool inQuotes = false;

    for (qsizetype i = 0; i < exec.size(); ++i) {
        const QChar c = exec.at(i);
        if (c == u'%') {
            if (i + 1 >= exec.size())
                return std::nullopt;
            const QChar code = exec.at(++i);
            if (code == u'%') {
                current += u'%';
                haveArg = true;
            } else if (!kCodes.contains(code)) {
                return std::nullopt;
            } // a known field code: dropped
            continue;
        }
        if (inQuotes) {
            if (c == u'\\' && i + 1 < exec.size() && QStringView(u"\"`$\\").contains(exec.at(i + 1)))
                current += exec.at(++i);
            else if (c == u'"')
                inQuotes = false;
            else
                current += c;
            continue;
        }
        if (c == u' ' || c == u'\t') {
            if (haveArg)
                args << current;
            current.clear();
            haveArg = false;
            continue;
        }
        if (c == u'"') {
            inQuotes = true;
            haveArg = true;
            continue;
        }
        if (kShell.contains(c) || c == u'\\' || c == u'\n')
            return std::nullopt;
        current += c;
        haveArg = true;
    }
    if (inQuotes)
        return std::nullopt;
    if (haveArg)
        args << current;
    // The program must be a real token: an empty or marker-only first token is rejected
    // before the markers are dropped, so "@@ evil" cannot promote "evil" to the program.
    if (args.isEmpty() || args.first().isEmpty() || args.first() == u"@@" || args.first() == u"@@u")
        return std::nullopt;
    args.removeIf([](const QString& a) { return a.isEmpty() || a == u"@@" || a == u"@@u"; });
    if (args.isEmpty() || args.first().isEmpty())
        return std::nullopt;
    return args;
}

QList<DesktopEntry> readDesktopEntries(const QStringList& dirs)
{
    QList<DesktopEntry> out;
    QSet<QString> seen;
    for (const QString& dir : dirs) {
        const QFileInfoList files = QDir(dir).entryInfoList({u"*.desktop"_s}, QDir::Files | QDir::Readable, QDir::Name);
        for (const QFileInfo& info : files) {
            const QString id = info.completeBaseName();
            if (seen.contains(id))
                continue;
            if (auto entry = parseDesktopEntry(info.absoluteFilePath())) {
                seen.insert(id);
                if (!entry->hidden) // Hidden=true deletes the id from later dirs too
                    out.append(*entry);
            }
        }
    }
    return out;
}

QStringList applicationDirectories()
{
    QString home = qEnvironmentVariable("XDG_DATA_HOME");
    if (home.isEmpty())
        home = QDir::homePath() + u"/.local/share"_s;
    QString system = qEnvironmentVariable("XDG_DATA_DIRS");
    if (system.isEmpty())
        system = u"/usr/local/share:/usr/share"_s;
    QStringList out{home + u"/applications"_s};
    for (const QString& dir : system.split(u':', Qt::SkipEmptyParts))
        out << QDir::cleanPath(dir) + u"/applications"_s;
    // Flatpak exports have lowest precedence, whether or not installed.
    out << home + u"/flatpak/exports/share/applications"_s
        << u"/var/lib/flatpak/exports/share/applications"_s;
    out.removeDuplicates();
    return out;
}

} // namespace jarvis::ui
