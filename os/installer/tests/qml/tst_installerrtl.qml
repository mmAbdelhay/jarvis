import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    name: "InstallerRtl"
    when: windowShown
    visible: true
    width: 1440
    height: 900
    Component { id: rootComponent; InstallerRoot { width: 1440; height: 900 } }
    function cleanup() { testLanguage.setLanguage("en") }
    function test_arabicFromWelcomeMirrorsAndTranslates() {
        const model = harness.fresh()
        const root = createTemporaryObject(rootComponent, this, { installer: model })
        tryCompare(model, "probed", true)
        compare(findChild(root, "screenTitle").text, "Welcome")
        verify(findChild(root, "rail_0").mapToItem(root, 0, 0).x < root.width / 2)
        model.locale.language = "ar_EG.UTF-8"
        tryCompare(findChild(root, "screenTitle"), "text", "مرحبًا")
        tryVerify(() => findChild(root, "rail_0").mapToItem(root, 0, 0).x > root.width / 2)
        compare(findChild(root, "railTitle").text, "تثبيت " + Brand.distroName)
        compare(findChild(root, "backButton").text, "رجوع")
        model.locale.language = "en_US.UTF-8"
        tryCompare(findChild(root, "screenTitle"), "text", "Welcome")
        tryVerify(() => findChild(root, "rail_0").mapToItem(root, 0, 0).x < root.width / 2)
    }
    function test_backupModelLineIsShown() {
        const model = harness.fresh()
        const root = createTemporaryObject(rootComponent, this, { installer: model })
        tryCompare(model, "probed", true)
        model.next()
        model.next()
        model.account.fullName = "Mo"
        model.account.password = "abcdEF12"
        model.account.confirm = "abcdEF12"
        model.next()
        compare(model.step, 3)
        verify(findChild(root, "backupNote"))
        verify(findChild(root, "backupNote").visible)
    }
}
