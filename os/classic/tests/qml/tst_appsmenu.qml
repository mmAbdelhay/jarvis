import QtQuick
import QtTest
import Jarvis.Classic

TestCase {
    name: "AppsMenu"
    when: windowShown
    visible: true
    width: 400
    height: 520

    Component { id: menu; AppsMenu { width: 360; height: 480; controller: testController } }

    function cleanup() { testController.closeApps() }

    function test_searchThenEnterLaunchesTheFirstMatch() {
        testController.toggleApps()
        const m = createTemporaryObject(menu, this)
        const search = findChild(m, "appSearch")
        m.focusSearch()
        search.text = "htop"
        tryCompare(findChild(m, "appList"), "count", 1)
        keyClick(Qt.Key_Return)
        compare(testStarts.all[testStarts.all.length - 1], "foot -- htop")
        verify(!testController.appsOpen)
    }

    function test_noMatchSaysSo() {
        testController.toggleApps()
        const m = createTemporaryObject(menu, this)
        findChild(m, "appSearch").text = "zzzz-nothing"
        tryVerify(() => findChild(m, "noApps").visible)
    }

    function test_clickLaunches() {
        testController.toggleApps()
        const m = createTemporaryObject(menu, this)
        tryVerify(() => findChild(m, "app_foot") !== null) // delegates are created after the first frame
        const item = findChild(m, "app_foot")
        mouseClick(item)
        compare(testStarts.all[testStarts.all.length - 1], "foot")
    }
}
