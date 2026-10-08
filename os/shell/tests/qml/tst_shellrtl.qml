import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    name: "ShellRtl"
    when: windowShown
    visible: true
    width: 1280
    height: 800

    Component { id: rootComponent; ShellRoot { width: 1280; height: 800; shell: testShell } }

    function cleanup() { testLanguage.setLanguage("en") }

    function test_englishRailOnTheLeft() {
        const root = createTemporaryObject(rootComponent, this)
        const chat = findChild(root, "navChat")
        verify(chat.mapToItem(root, 0, 0).x < root.width / 2)
        compare(chat.Accessible.name, "Chat")
    }

    function test_arabicMirrorsTheFrameAndTranslates() {
        verify(testLanguage.setLanguage("ar"))
        const root = createTemporaryObject(rootComponent, this)
        const chat = findChild(root, "navChat")
        verify(chat.mapToItem(root, 0, 0).x > root.width / 2)
        compare(chat.Accessible.name, "المحادثة")
        compare(findChild(root, "navSettings").Accessible.name, "الإعدادات")
        compare(findChild(root, "loadingText").text, "جارٍ الاتصال بجارفيس…")
    }

    function test_arabicTranslatesCustomProviderWithoutChangingItsId() {
        verify(testLanguage.setLanguage("ar"))
        const root = createTemporaryObject(rootComponent, this)
        const preset = findChild(root, "preset_Custom URL")
        verify(preset !== null)
        compare(preset.title, "عنوان مخصّص")
    }

    function test_switchingBackRestoresEnglish() {
        const root = createTemporaryObject(rootComponent, this)
        verify(testLanguage.setLanguage("ar"))
        tryCompare(findChild(root, "navChat").Accessible, "name", "المحادثة")
        verify(testLanguage.setLanguage("en"))
        tryCompare(findChild(root, "navChat").Accessible, "name", "Chat")
        tryVerify(() => findChild(root, "navChat").mapToItem(root, 0, 0).x < root.width / 2)
    }
}
