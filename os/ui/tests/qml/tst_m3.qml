import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    id: testCase
    name: "M3Additions"
    when: windowShown
    visible: true
    width: 600
    height: 600

    Component { id: changeComponent; ChangeValue {} }
    Component { id: clockComponent; ClockHeader {} }
    Component { id: panelComponent; PasswordPanel { width: 360 } }
    Component { id: spyComponent; SignalSpy {} }

    function test_icons() {
        for (const name of ["mic", "lock", "undo", "phone", "speaker"])
            verify(Icons[name].length > 10, name)
    }

    function test_changeValueIsPlainText() {
        const c = createTemporaryObject(changeComponent, testCase, { from: "<b>40%</b>", to: "70%" })
        const from = findChild(c, "changeFrom")
        compare(from.text, "<b>40%</b>")
        compare(from.textFormat, Text.PlainText)
        compare(findChild(c, "changeTo").text, "70%")
        compare(findChild(c, "changeTo").textFormat, Text.PlainText)
        verify(c.Accessible.name.indexOf("40%") >= 0)
    }

    function test_clockShowsTheGivenTime() {
        const c = createTemporaryObject(clockComponent, testCase, { now: new Date(2026, 9, 9, 7, 5) })
        compare(findChild(c, "clock").text, "07:05")
        verify(findChild(c, "date").text.length > 0)
    }

    function test_submitEmitsAndClears() {
        const p = createTemporaryObject(panelComponent, testCase, { initial: "M", displayName: "Muhammad" })
        const spy = createTemporaryObject(spyComponent, testCase, { target: p, signalName: "submitted" })
        compare(findChild(p, "avatarInitial").text, "M")
        const field = findChild(p, "passwordField")
        p.focusField()
        verify(field.activeFocus)
        keyClick(Qt.Key_Return) // empty: nothing
        compare(spy.count, 0)
        for (const character of "s3cret")
            keyClick(character)
        keyClick(Qt.Key_Return)
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "s3cret")
        compare(field.text, "")
    }

    function test_busyDisablesTheField() {
        const p = createTemporaryObject(panelComponent, testCase, { busy: true })
        verify(!findChild(p, "passwordField").enabled)
        verify(!findChild(p, "submitButton").enabled)
    }

    function test_errorIsPlainText() {
        const p = createTemporaryObject(panelComponent, testCase, { errorText: "<i>Nope</i>" })
        const e = findChild(p, "errorText")
        verify(e.visible)
        compare(e.textFormat, Text.PlainText)
    }

    function test_clockTicks() {
        const c = createTemporaryObject(clockComponent, testCase, { now: new Date(2000, 0, 1) })
        tryVerify(function() { return c.now.getFullYear() !== 2000 }, 2000)
    }

    function test_clickClearsBeforeEmitting() {
        const p = createTemporaryObject(panelComponent, testCase)
        const field = findChild(p, "passwordField")
        const spy = createTemporaryObject(spyComponent, testCase, { target: p, signalName: "submitted" })
        let textAtEmission = null
        p.submitted.connect(function(secret) { textAtEmission = field.text })
        field.text = "secret"
        mouseClick(findChild(p, "submitButton"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "secret")
        compare(textAtEmission, "")
        mouseClick(findChild(p, "submitButton"))
        compare(spy.count, 1)
    }

    function test_clearAndBusyRefuseSubmission() {
        const p = createTemporaryObject(panelComponent, testCase)
        const field = findChild(p, "passwordField")
        const spy = createTemporaryObject(spyComponent, testCase, { target: p, signalName: "submitted" })
        field.text = "secret"
        p.clear()
        compare(field.text, "")
        field.text = "secret"
        p.busy = true
        p.submit()
        compare(spy.count, 0)
        compare(field.text, "")
    }

    function test_passwordAndUntrustedText() {
        const p = createTemporaryObject(panelComponent, testCase, {
            initial: "<b>M</b>", displayName: "<b>Name</b>", infoText: "<i>Info</i>",
            prompt: "Admin password", submitLabel: "Continue"
        })
        for (const name of ["avatarInitial", "name", "infoText"])
            compare(findChild(p, name).textFormat, Text.PlainText)
        const field = findChild(p, "passwordField")
        compare(field.echoMode, TextInput.Password)
        verify((field.inputMethodHints & Qt.ImhSensitiveData) !== 0)
        compare(field.placeholderText, "Admin password")
        compare(field.Accessible.name, "Admin password")
        compare(findChild(p, "submitButton").Accessible.name, "Continue")
        verify(findChild(p, "infoText").visible)
        p.infoText = ""
        verify(!findChild(p, "infoText").visible)
    }
}
