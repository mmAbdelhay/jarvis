import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    name: "LanguageSection"
    when: windowShown
    visible: true
    width: 800
    height: 400

    Component { id: section; LanguageSection { width: 760; shell: testShell } }

    function test_showsBothLanguagesAndTheCurrentOne() {
        const s = createTemporaryObject(section, this)
        const en = findChild(s, "language_en")
        const ar = findChild(s, "language_ar")
        verify(en && ar)
        compare(en.title, "English")
        compare(ar.title, "العربية")
        verify(en.selected)
        verify(!ar.selected)
    }

    function test_choosingWithoutJarvisExplainsWhy() {
        const s = createTemporaryObject(section, this)
        mouseClick(findChild(s, "language_ar"))
        // testShell has no daemon: the request fails at once with "closed".
        tryVerify(() => findChild(s, "languageNote").visible)
        verify(findChild(s, "languageNote").text.length > 0)
        verify(findChild(s, "language_en").selected)
    }
}
