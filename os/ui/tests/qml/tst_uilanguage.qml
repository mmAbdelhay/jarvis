import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    name: "UiLanguage"
    when: windowShown

    function cleanup() { testLanguage.setLanguage("en") }

    function test_followsTheManager() {
        compare(UiLanguage.code, "en")
        verify(!UiLanguage.rightToLeft)
        verify(testLanguage.setLanguage("ar"))
        tryCompare(UiLanguage, "code", "ar")
        verify(UiLanguage.rightToLeft)
        compare(Qt.application.layoutDirection, Qt.RightToLeft)
    }

    function test_formatsInTheGivenLanguage() {
        const when = new Date(2026, 9, 7, 9, 5)
        compare(UiLanguage.formatTime(when, "en"), "09:05")
        compare(UiLanguage.formatDate(when, "en"), "Wednesday, 7 October")
        compare(UiLanguage.formatDate(when, "ar"), "الأربعاء، 7 أكتوبر")
        compare(UiLanguage.format(when, "d MMM", "ar"), "7 أكتوبر")
    }
}
