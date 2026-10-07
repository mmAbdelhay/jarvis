#include <QTemporaryFile>
#include <QtTest>

#include "UserList.h"

using namespace Qt::StringLiterals;

class TestUserList : public QObject {
    Q_OBJECT
private slots:
    void humansOnlySortedByUid()
    {
        QTemporaryFile passwd;
        QVERIFY(passwd.open());
        passwd.write("root:x:0:0:root:/root:/bin/bash\n"
                     "_greetd:x:998:998::/var/lib/greetd:/usr/sbin/nologin\n"
                     "sara:x:1001:1001:Sara Ali,,,:/home/sara:/bin/bash\n"
                     "mohamed:x:1000:1000:Mohamed Abdelhay,,,:/home/mohamed:/bin/bash\n"
                     "svc:x:1002:1002::/srv:/usr/sbin/nologin\n"
                     "ghost:x:1003:1003::/home/ghost:/bin/false\n"
                     "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n"
                     "noname:x:1004:1004::/home/noname:/bin/zsh\n"
                     "broken line\n");
        passwd.close();
        const QList<UserEntry> users = readUsers(passwd.fileName());
        QCOMPARE(users.size(), 3);
        QCOMPARE(users.at(0).username, u"mohamed"_s);
        QCOMPARE(users.at(0).displayName, u"Mohamed Abdelhay"_s);
        QCOMPARE(users.at(1).username, u"sara"_s);
        QCOMPARE(users.at(2).displayName, u"noname"_s);
        QVERIFY(readUsers(u"/nonexistent/passwd"_s).isEmpty());
    }
};

QTEST_GUILESS_MAIN(TestUserList)
#include "tst_userlist.moc"
