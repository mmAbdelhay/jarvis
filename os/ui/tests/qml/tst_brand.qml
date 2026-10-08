import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    name: "Brand"

    function test_distroNameComesFromOsRelease() {
        compare(Brand.distroName, "Testix OS")
    }
}
