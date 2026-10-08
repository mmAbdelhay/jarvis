import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    name: "SettingsWindow"
    when: windowShown

    Component { id: windowComponent; SettingsWindow { shell: testShell } }

    function cleanup() { testLanguage.setLanguage("en") }

    function test_showsSettingsOnItsOwn() {
        const w = createTemporaryObject(windowComponent, this)
        w.show()
        compare(w.title, "Jarvis Settings")
        const page = findChild(w.contentItem, "settingsPage")
        verify(page)
        verify(findChild(page, "providersSection"))
        verify(findChild(page, "section_language"))
        verify(!findChild(w.contentItem, "navChat"))   // no chat frame in this window
    }

    function test_arabicTitleAndMirroring() {
        verify(testLanguage.setLanguage("ar"))
        const w = createTemporaryObject(windowComponent, this)
        w.show()
        compare(w.title, "إعدادات جارفيس")
        verify(findChild(w.contentItem, "settingsRoot").LayoutMirroring.enabled)
    }
}
