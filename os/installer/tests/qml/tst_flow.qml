import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "InstallerFlow"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component { id: rootComponent; InstallerRoot {} }

    function make() {
        const m = harness.fresh()
        const r = createTemporaryObject(rootComponent, testCase, { installer: m, width: 1440, height: 900 })
        tryCompare(m, "probed", true)
        waitForRendering(r)
        return { m: m, r: r }
    }
    function shot(r, name) {
        if (harness.screenshotDir.length > 0)
            grabImage(r).save(harness.screenshotDir + "/installer-" + name + ".png")
    }
    function typeInto(field, text) {
        field.input.forceActiveFocus()
        for (const ch of text)
            keyClick(ch)
    }
    function next(c) { mouseClick(findChild(c.r, "nextButton")) }
    function toReview(c) {
        shot(c.r, "1-welcome"); next(c)
        shot(c.r, "2-disk"); next(c)
        typeInto(findChild(c.r, "fullName"), "Mohamed Abdelhay")
        typeInto(findChild(c.r, "password"), "abcdEF12")
        typeInto(findChild(c.r, "confirm"), "abcdEF12")
        shot(c.r, "3-account"); next(c)
        shot(c.r, "4-brain"); next(c)
        tryCompare(c.m, "step", 4)
        waitForRendering(c.r)
        shot(c.r, "5-review")
    }

    function test_railAndFooter() {
        const c = make()
        compare(findChild(c.r, "railTitle").text, "Install Rafiq")
        compare(findChild(c.r, "backButton").opacity, 0)
        compare(findChild(c.r, "nextButton").text, "Continue")
        verify(!findChild(c.r, "rail_3").enabled)
    }

    function test_wholeFlowWithOneExecute() {
        const c = make()
        toReview(c)
        const install = findChild(c.r, "nextButton")
        compare(install.text, "Install")
        compare(install.variant, "approve")
        compare(harness.calls(), ["Probe", "Plan"])
        mouseClick(install)
        mouseClick(install)                       // a double click sends one Execute
        tryCompare(c.m, "step", 5)
        compare(harness.calls().filter((x) => x === "Execute").length, 1)
        harness.progress("copy", 62, "Copying system files")
        harness.modelProgress(37, "1.9 of 5.2 GB")
        waitForRendering(c.r)
        shot(c.r, "6-installing")
        compare(findChild(c.r, "backButton").opacity, 0)
        harness.finish(true, "", "")
        tryCompare(c.m, "step", 6)
        waitForRendering(c.r)
        shot(c.r, "7-done")
        mouseClick(findChild(c.r, "nextButton"))
        compare(harness.powerCalls(), ["Reboot"])
    }

    function test_backFromReviewChangesNothing() {
        const c = make()
        toReview(c)
        mouseClick(findChild(c.r, "backButton"))
        compare(c.m.step, 3)
        compare(harness.calls(), ["Probe", "Plan"])
        mouseClick(findChild(c.r, "rail_1"))
        compare(c.m.step, 1)
        compare(harness.calls(), ["Probe", "Plan"])
    }

    function test_refusalIsShownInPlainWords() {
        const c = make()
        next(c); next(c)
        typeInto(findChild(c.r, "fullName"), "Mo")
        typeInto(findChild(c.r, "password"), "abcdEF12")
        typeInto(findChild(c.r, "confirm"), "abcdEF12")
        next(c)
        harness.refuseNext("ntfs-dirty", "ntfsresize: NTFS is inconsistent")
        next(c)
        tryCompare(c.m, "step", 1)
        verify(findChild(c.r, "refusalNotice").visible)
        verify(findChild(c.r, "refusalText").text.indexOf("hold Shift + Shut down") >= 0)
        verify(findChild(c.r, "refusalText").text.indexOf("ntfs-dirty") < 0)
        verify(harness.calls().indexOf("Execute") < 0)
    }
}
