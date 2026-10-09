import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "DoctorView"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component { id: doctorComponent; DoctorModel {} }
    Component { id: cardComponent; CardModel {} }
    Component { id: viewComponent; DoctorView {} }
    Component { id: spyComponent; SignalSpy {} }

    readonly property var steps: [
        { stepId: "radio", label: "Wi-Fi radio is on", status: "ok", detail: "rfkill: not blocked" },
        { stepId: "nm", label: "NetworkManager is running", status: "fixed", detail: "restarted" },
        { stepId: "connection", label: "No known network nearby", status: "problem", detail: "Saved: Office-Guest (not in range)" },
        { stepId: "dns", label: "DNS answers", status: "pending", detail: "" },
        { stepId: "provider", label: "Model provider reachable", status: "running", detail: "" }
    ]
    readonly property var networks: [
        { ssid: "Home-5G", signal: 80, security: "WPA2", known: false },
        { ssid: "CoffeeBar Free", signal: 20, security: "open", known: false }
    ]

    function makeView() {
        const doctor = createTemporaryObject(doctorComponent, testCase)
        const card = createTemporaryObject(cardComponent, testCase)
        doctor.applyState({ active: true, steps: steps, networks: networks, done: null })
        const view = createTemporaryObject(viewComponent, testCase,
                                           { doctor: doctor, card: card, providerError: "this computer is offline", width: 1440, height: 900 })
        waitForRendering(view)
        return { doctor: doctor, card: card, view: view }
    }

    function glyph(view, stepId) {
        return findChild(findChild(view, "step_" + stepId), "glyph").text
    }

    function test_stepsShowTheirStatus() {
        const c = makeView()
        compare(glyph(c.view, "radio"), "✓")
        compare(glyph(c.view, "nm"), "✓")
        compare(glyph(c.view, "connection"), "!")
        compare(glyph(c.view, "dns"), "4")
        compare(glyph(c.view, "provider"), "…")
        verify(findChild(c.view, "doctorBanner").visible)
        verify(findChild(c.view, "networksList").visible)
    }

    function test_skipAProblem() {
        const c = makeView()
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.doctor, signalName: "skipRequested" })
        verify(!findChild(c.view, "skip_radio").visible)
        mouseClick(findChild(c.view, "skip_connection"))
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "connection")
    }

    function test_pickANetworkAndConnect() {
        const c = makeView()
        c.card.setClockForTest(1000)
        verify(c.card.load({ cardId: "w", turnId: null, expiresAt: 301000, items: [
            { itemId: "home", tool: "net.wifi_connect", title: "Connect to Home-5G", detail: "WPA2 · strong", source: "network", risk: "confirm",
              secretFields: [{ name: "password", label: "Wi-Fi password" }] },
            { itemId: "cafe", tool: "net.wifi_connect", title: "Connect to CoffeeBar Free", detail: "open · weak", source: "network", risk: "confirm",
              secretFields: [] }] }))
        tryVerify(() => findChild(c.view, "doctorCard").visible)
        verify(!findChild(c.view, "networksList").visible)  // the card lists the networks now
        verify(!findChild(c.view, "skip_connection").visible)
        waitForRendering(c.view)  // let the layout settle before clicking by position
        mouseClick(findChild(c.view, "tick_home"))
        tryVerify(() => findChild(c.view, "secret_home_password") !== null)
        const field = findChild(c.view, "secret_home_password").field
        field.forceActiveFocus()
        for (const ch of "pa55word")
            keyClick(ch)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "decided" })
        mouseClick(findChild(c.view, "approveButton"))
        compare(spy.signalArguments[0][0], true)
        const d = c.card.decision(true)
        compare(d.ticked, ["home"])
        compare(d.secrets, { home: { password: "pa55word" } })
    }

    function test_outcomes() {
        const c = makeView()
        verify(!findChild(c.view, "doctorOutcome").visible)
        c.doctor.applyState({ active: false, steps: steps, networks: [], done: "unfixed" })
        const outcome = findChild(c.view, "doctorOutcome")
        tryVerify(() => outcome.visible)
        verify(outcome.text.indexOf("hotspot") >= 0)
        const starts = createTemporaryObject(spyComponent, testCase, { target: c.doctor, signalName: "startRequested" })
        mouseClick(findChild(c.view, "runAgain"))
        compare(starts.count, 1)
        c.doctor.applyState({ active: false, steps: steps, networks: [], done: "fixed" })
        compare(outcome.text, "The network works again.")
        const back = createTemporaryObject(spyComponent, testCase, { target: c.view, signalName: "backRequested" })
        mouseClick(findChild(c.view, "backButton"))
        compare(back.count, 1)
    }
}
