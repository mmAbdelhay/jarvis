import QtQuick
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "AuditView"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    property var activeView: null

    function cleanup() {
        // Destroy bindings before the temporary model is cleaned up.
        if (activeView) {
            activeView.destroy()
            activeView = null
            wait(0)
        }
    }

    Component { id: auditComponent; AuditModel {} }
    Component { id: viewComponent; AuditView {} }
    Component { id: spyComponent; SignalSpy {} }

    function entry(ts, title, decision, result, message) {
        return { ts: ts, tool: "pkg.install", title: title, input: {}, decision: decision, via: "desktop",
                 result: result, message: message === undefined ? "" : message }
    }

    function makeView(entries) {
        const audit = createTemporaryObject(auditComponent, testCase)
        audit.applyEntries(entries, false)
        const view = createTemporaryObject(viewComponent, testCase, { audit: audit, width: 1440, height: 900 })
        activeView = view
        waitForRendering(view)

        return { audit: audit, view: view, list: findChild(view, "auditList") }
    }

    function test_rowsAndFilters() {
        const c = makeView([entry(3000, "Install VLC 3.0.21 from Debian", "approved", "ok"),
                            entry(2000, "Install steam from Debian", "approved", "failed", "needs i386 enabled"),
                            entry(1000, "Remove GIMP", "denied", "skipped")])
        compare(c.list.count, 3)
        mouseClick(findChild(c.view, "filter_denied"))
        compare(c.audit.filter, "denied")
        compare(c.list.count, 1)
        mouseClick(findChild(c.view, "filter_failed"))
        compare(c.list.count, 1)
        tryVerify(() => findChild(c.view, "chip_0") !== null)
        compare(findChild(c.view, "chip_0").text, "Approved")
        mouseClick(findChild(c.view, "filter_all"))
        compare(c.list.count, 3)
    }

    function test_emptyState() {
        const c = makeView([])
        verify(findChild(c.view, "emptyText").visible)
    }

    function test_loadOlder() {
        const page = []
        for (let i = 0; i < 200; ++i)
            page.push(entry(10000 - i, "t" + i, "approved", "ok"))
        const c = makeView(page)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.audit, signalName: "listRequested" })
        c.list.positionViewAtEnd() // the footer sits after 200 rows
        waitForRendering(c.view)
        const more = findChild(c.view, "loadMore")
        verify(more.visible)
        mouseClick(more)
        compare(spy.count, 1)
        compare(spy.signalArguments[0][1], 9801)
    }

    function test_back() {
        const c = makeView([])
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "backRequested" })
        mouseClick(findChild(c.view, "backLink"))
        compare(spy.count, 1)
    }
}
