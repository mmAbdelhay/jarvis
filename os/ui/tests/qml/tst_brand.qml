import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    name: "Brand"
    when: windowShown

    function cleanup() { testLanguage.setLanguage("en") }

    function test_distroNameComesFromBrandJson() {
        compare(Brand.distroName, "Testix OS")
    }

    // M4 contracts §6.8: Arabic UI text shows the Arabic name from brand.json.
    function test_distroNameFollowsTheLanguage() {
        verify(testLanguage.setLanguage("ar"))
        tryCompare(Brand, "distroName", "تستكس")
        verify(testLanguage.setLanguage("en"))
        tryCompare(Brand, "distroName", "Testix OS")
    }
}
