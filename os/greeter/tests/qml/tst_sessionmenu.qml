import QtQuick
import QtTest
import Jarvis.Greeter

TestCase {
    name: "SessionMenu"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component { id: screen; LoginScreen { width: 1440; height: 900 } }

    function init() { testLanguage.setLanguage("en") }
    function cleanup() { testLanguage.setLanguage("en") }

    function test_menuListsSessionsAndPicksClassic() {
        const login = harness.fresh({ offline: true, sessionsDir: harness.sessionsDir() })
        const s = createTemporaryObject(screen, this, { login: login, modelStatus: harness.status("") })
        const button = findChild(s, "sessionButton")
        verify(button.visible)
        compare(button.text, "Rafiq")
        mouseClick(button)
        const menu = findChild(s, "sessionMenu")
        tryCompare(menu, "opened", true)
        const classic = menu.itemAt(1)
        compare(classic.objectName, "session_rafiq-classic")
        tryVerify(() => classic && classic.visible)
        mouseClick(classic)
        compare(login.sessionId, "rafiq-classic")
        compare(button.text, "Rafiq (classic)")
    }

    function test_languageChangeKeepsSelection() {
        const login = harness.fresh({ offline: true, sessionsDir: harness.sessionsDir() })
        const s = createTemporaryObject(screen, this, { login: login, modelStatus: harness.status("") })
        login.sessionId = "rafiq-classic"
        verify(testLanguage.setLanguage("ar"))
        compare(login.sessionId, "rafiq-classic")
        compare(findChild(s, "sessionButton").text, "رفيق (الكلاسيكي)")
    }

    function test_oneOrNoSessionHidesTheMenu() {
        const s = createTemporaryObject(screen, this, { login: harness.fresh({ offline: true }), modelStatus: harness.status("") })
        verify(!findChild(s, "sessionButton").visible)
    }
}
