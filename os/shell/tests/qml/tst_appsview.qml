import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "AppsView"
    when: windowShown
    visible: true
    width: 1200
    height: 800

    Component { id: rootComponent; ShellRoot {} }
    Component { id: spyComponent; SignalSpy {} }

    function init() { testLanguage.setLanguage("en"); testAppsShell.showView("chat") }
    function cleanup() { testLanguage.setLanguage("en") }

    function openApps() {
        const root = createTemporaryObject(rootComponent, testCase, { shell: testAppsShell, width: 1200, height: 800 })
        testAppsShell.showView("apps")
        waitForRendering(root)
        return root
    }

    function test_navRailHasAppsBetweenActivityAndSettings() {
        const root = createTemporaryObject(rootComponent, testCase, { shell: testAppsShell, width: 1200, height: 800 })
        const audit = findChild(root, "navAudit"), apps = findChild(root, "navApps"), settings = findChild(root, "navSettings")
        verify(apps !== null)
        verify(audit.y < apps.y && apps.y < settings.y)
        compare(apps.Accessible.name, "Apps")
    }

    function test_listsInstalledAppsSorted() {
        const root = openApps()
        compare(testAppsShell.view, "apps")
        verify(findChild(root, "appsView").visible)
        verify(findChild(root, "app_firefox-esr") !== null)
        verify(findChild(root, "app_org.gimp.GIMP") !== null)
        compare(findChild(root, "app_hidden"), null)
        compare(testAppsShell.apps.idAt(0), "firefox-esr")
    }

    function test_clickLaunchesAtOnce() {
        const root = openApps()
        const before = testApps.launchCount()
        mouseClick(findChild(root, "app_org.gimp.GIMP"))
        compare(testApps.launchCount(), before + 1)
        compare(testApps.lastLaunch(), ["gimp"])
    }

    function test_searchThenEnterLaunchesFirst() {
        const root = openApps()
        const search = findChild(root, "appsSearch")
        search.forceActiveFocus()
        for (const ch of "fire") keyClick(ch)
        compare(testAppsShell.apps.count, 1)
        const before = testApps.launchCount()
        keyClick(Qt.Key_Return)
        compare(testApps.launchCount(), before + 1)
        compare(testApps.lastLaunch()[0], "firefox-esr")
    }

    function test_noMatchOffersAskJarvis() {
        const root = openApps()
        const search = findChild(root, "appsSearch")
        search.forceActiveFocus()
        for (const ch of "resize my photo") keyClick(ch)
        compare(testAppsShell.apps.count, 0)
        const ask = findChild(root, "askJarvis")
        verify(ask.visible)
        compare(ask.text, "Ask Jarvis: resize my photo")
        mouseClick(ask)
        compare(testAppsShell.view, "chat")
    }

    function test_keyboardMovesThroughTheGrid() {
        const root = openApps()
        const search = findChild(root, "appsSearch")
        search.forceActiveFocus()
        keyClick(Qt.Key_Down)
        const grid = findChild(root, "appsGrid")
        verify(grid.activeFocus)
        keyClick(Qt.Key_Right)
        compare(grid.currentIndex, 1)
        compare(grid.currentItem.background.border.color, Theme.accentTintBorder)
        const before = testApps.launchCount()
        keyClick(Qt.Key_Return)
        compare(testApps.launchCount(), before + 1)
    }

    function test_arabicAppsAndSearch() {
        verify(testLanguage.setLanguage("ar"))
        const root = openApps()
        compare(findChild(root, "navApps").Accessible.name, "التطبيقات")
        compare(findChild(root, "appsSearch").placeholderText, "ابحث في التطبيقات، أو اسأل جارفيس")
        const tile = findChild(root, "app_firefox-esr")
        compare(tile.Accessible.name, "فايرفوكس")
        const search = findChild(root, "appsSearch")
        search.text = "nonexistent"
        compare(findChild(root, "askJarvis").text, "اسأل جارفيس: nonexistent")
        verify(findChild(root, "navApps").mapToItem(root, 0, 0).x > root.width / 2)
    }

    function test_rejectedPromptKeepsAppsOpen() {
        openApps()
        testAppsShell.askJarvis(" ")
        compare(testAppsShell.view, "apps")
        testAppsShell.askJarvis("x".repeat(8001))
        compare(testAppsShell.view, "apps")
    }

    function test_escapeGoesBackToChat() {
        openApps()
        testAppsShell.escape()
        compare(testAppsShell.view, "chat")
    }
}
