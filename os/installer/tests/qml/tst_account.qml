import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "AccountScreen"
    when: windowShown
    visible: true
    width: 900
    height: 900

    Component { id: screenComponent; AccountScreen {} }

    function make() {
        const m = harness.fresh()
        tryCompare(m, "probed", true)
        m.next()
        m.next()
        const s = createTemporaryObject(screenComponent, testCase, { installer: m, width: 780 })
        waitForRendering(s)
        return { m: m, s: s }
    }
    function typeInto(field, text) {
        field.input.forceActiveFocus()
        for (const ch of text)
            keyClick(ch)
    }

    function test_nameDerivesUsernameAndComputerName() {
        const c = make()
        compare(findChild(c.s, "screenTitle").text, "Your account")
        typeInto(findChild(c.s, "fullName"), "Mohamed Abdelhay")
        compare(findChild(c.s, "username").input.text, "mohamed")
        compare(findChild(c.s, "hostname").input.text, "mohamed-computer")
        compare(findChild(c.s, "username").input.font.family, Theme.mono)
    }

    function test_passwordsAreMaskedWithAStatusLine() {
        const c = make()
        const password = findChild(c.s, "password")
        compare(password.input.echoMode, TextInput.Password)
        compare(findChild(c.s, "confirm").input.echoMode, TextInput.Password)
        typeInto(password, "abcdEF12")
        typeInto(findChild(c.s, "confirm"), "abcdEF12")
        compare(findChild(c.s, "passwordStatus").text, "Strong password · passwords match")
        verify(Qt.colorEqual(findChild(c.s, "passwordStatus").color, Theme.accentHover))
    }

    function test_badUsernameIsExplained() {
        const c = make()
        typeInto(findChild(c.s, "fullName"), "Mo")
        c.m.account.username = "Root"
        compare(findChild(c.s, "username").input.text, "Root")
        verify(findChild(c.s, "nameProblems").text.indexOf("Use lowercase") >= 0)
    }

    function test_autologinIsOffByDefault() {
        const c = make()
        const auto = findChild(c.s, "autologin")
        verify(!auto.checked)
        compare(auto.text, "Log in automatically (not recommended on a laptop)")
        mouseClick(auto)
        verify(c.m.account.autologin)
    }

    function test_separateDiskPassphraseOnlyWhenUnticked() {
        const c = make()
        const same = findChild(c.s, "diskSame")
        verify(same.visible)
        verify(same.checked)
        verify(!findChild(c.s, "diskPassphrase").visible)
        mouseClick(same)
        verify(findChild(c.s, "diskPassphrase").visible)
        compare(findChild(c.s, "diskPassphrase").input.echoMode, TextInput.Password)
        c.m.disk.encrypt = false
        verify(!same.visible)
    }
}
