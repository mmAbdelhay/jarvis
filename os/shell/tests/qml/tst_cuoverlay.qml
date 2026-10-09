import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "CuOverlay"
    when: windowShown
    visible: true
    width: 1280
    height: 800

    Component { id: sessionComponent; CuSessionModel {} }
    Component { id: overlayComponent; CuOverlay { width: 1280; height: 800 } }
    Component { id: windowComponent; CuOverlayWindow {} }
    Component { id: spyComponent; SignalSpy {} }

    function cleanup() { testLanguage.setLanguage("en") }

    function state(extra) {
        const s = { active: true, sessionId: "s1", goal: "Export beach.xcf as PNG to Pictures", apps: ["GIMP"],
                    step: 2, maxSteps: 50, paused: null,
                    steps: [{ title: "Open the File menu", status: "done" },
                            { title: "Choose <b>Export As</b>", status: "running" },
                            { title: "Save", status: "pending" }] }
        for (const k in extra)
            s[k] = extra[k]
        return s
    }

    function make(s, primary) {
        const session = createTemporaryObject(sessionComponent, testCase)
        if (s)
            session.applyState(s)
        const overlay = createTemporaryObject(overlayComponent, testCase,
                                              { session: session, primary: primary === undefined ? true : primary })
        waitForRendering(overlay)
        return { session: session, overlay: overlay }
    }

    function test_windowIsTransparentAndDoesNotAcceptFocus() {
        const session = createTemporaryObject(sessionComponent, testCase)
        const overlayWindow = createTemporaryObject(windowComponent, testCase, { session: session })
        verify(overlayWindow !== null)
        verify(Qt.colorEqual(overlayWindow.color, "transparent"))
        verify(overlayWindow.flags & Qt.FramelessWindowHint)
        verify(overlayWindow.flags & Qt.WindowDoesNotAcceptFocus)
        compare(overlayWindow.inputRects.length, 0)
    }

    function test_hiddenWhenInactive() {
        const c = make(null)
        verify(!findChild(c.overlay, "cuBorder").visible)
        verify(!findChild(c.overlay, "cuPill").visible)
        verify(!findChild(c.overlay, "cuPanel").visible)
        compare(c.overlay.inputRects.length, 0)
    }

    function test_runningShowsBorderPillAndSteps() {
        const c = make(state({}))
        const border = findChild(c.overlay, "cuBorder")
        verify(border.visible)
        verify(Qt.colorEqual(border.border.color, Theme.accent))
        compare(border.border.width, 4)
        compare(border.opacity, 1)
        compare(findChild(c.overlay, "cuStatus").text, "Jarvis is controlling the screen · step 2 of 50")
        verify(findChild(c.overlay, "cuTakeOver").visible)
        compare(findChild(c.overlay, "cuTakeOver").text, "Take over (Esc)")
        verify(!findChild(c.overlay, "cuResume").visible)
        verify(!findChild(c.overlay, "cuStop").visible)
        const goal = findChild(c.overlay, "cuGoal")
        compare(goal.text, "Screen control")
        compare(goal.textFormat, Text.PlainText)
        compare(findChild(c.overlay, "cuApps").text, "")
        const steps = findChild(c.overlay, "cuSteps")
        compare(steps.count, 3)
        const title = findChild(c.overlay, "cuStepTitle_1")
        compare(title.text, "Running")
        compare(title.textFormat, Text.PlainText)
        compare(findChild(c.overlay, "cuStep_1").Accessible.name, "Running")
    }

    function test_nullSessionHidesChrome() {
        const c = make(state({}))
        failOnWarning(/TypeError/)
        c.overlay.session = null
        waitForRendering(c.overlay)
        verify(!findChild(c.overlay, "cuBorder").visible)
        verify(!findChild(c.overlay, "cuPill").visible)
        compare(c.overlay.inputRects.length, 0)
    }

    function test_privateTextNeverAppears() {
        const c = make(state({ goal: "secret goal", apps: ["secret app"],
                               steps: [{ title: "secret step", status: "failed" }] }))
        waitForRendering(c.overlay)
        compare(findChild(c.overlay, "cuGoal").text, "Screen control")
        compare(findChild(c.overlay, "cuApps").text, "")
        compare(findChild(c.overlay, "cuStepTitle_0").text, "Failed")
        compare(findChild(c.overlay, "cuError").text, "")
    }

    function test_takeOverAsksToStop() {
        const c = make(state({}))
        const stops = createTemporaryObject(spyComponent, testCase, { target: c.session, signalName: "stopRequested" })
        mouseClick(findChild(c.overlay, "cuTakeOver"))
        compare(stops.count, 1)
        verify(!findChild(c.overlay, "cuTakeOver").enabled) // busy until jarvisd answers
    }

    function test_pausedOffersResumeAndStop() {
        const c = make(state({ paused: "physical-input" }))
        compare(findChild(c.overlay, "cuStatus").text, "Paused · you have control")
        compare(findChild(c.overlay, "cuDetail").text, "You moved the mouse or typed.")
        verify(!findChild(c.overlay, "cuTakeOver").visible)
        verify(findChild(c.overlay, "cuResume").visible)
        verify(findChild(c.overlay, "cuStop").visible)
        verify(findChild(c.overlay, "cuBorder").opacity < 1)
        const resumes = createTemporaryObject(spyComponent, testCase, { target: c.session, signalName: "resumeRequested" })
        mouseClick(findChild(c.overlay, "cuResume"))
        compare(resumes.count, 1)
    }

    function test_connectionLostShowsNoButtons() {
        const c = make(state({}))
        c.session.connectionClosed()
        waitForRendering(c.overlay)
        verify(findChild(c.overlay, "cuBorder").visible)
        compare(findChild(c.overlay, "cuStatus").text, "Lost the connection to Jarvis. Reconnecting…")
        verify(!findChild(c.overlay, "cuTakeOver").visible)
        verify(!findChild(c.overlay, "cuResume").visible)
        verify(!findChild(c.overlay, "cuStop").visible)
    }

    function test_otherOutputsShowOnlyTheBorder() {
        const c = make(state({}), false)
        verify(findChild(c.overlay, "cuBorder").visible)
        verify(!findChild(c.overlay, "cuPill").visible)
        verify(!findChild(c.overlay, "cuPanel").visible)
        compare(c.overlay.inputRects.length, 0)
    }

    function test_inputRectsArePillAndPanel() {
        const c = make(state({}))
        const pill = findChild(c.overlay, "cuPill")
        const panel = findChild(c.overlay, "cuPanel")
        const rects = c.overlay.inputRects
        compare(rects.length, 2)
        compare(rects[0].x, pill.x)
        compare(rects[0].y, pill.y)
        compare(rects[0].width, pill.width)
        compare(rects[0].height, pill.height)
        compare(rects[1].x, panel.x)
        compare(rects[1].height, panel.height)
        verify(pill.y >= 4 && pill.x > 0)                   // inside the border, centred
        verify(Math.abs(pill.x + pill.width / 2 - c.overlay.width / 2) <= 1)
        verify(panel.x > c.overlay.width / 2)               // trailing edge (right) in English
        verify(panel.y >= pill.y + pill.height)
    }

    function test_stepsFollowTheSession() {
        const c = make(state({}))
        c.session.applyState(state({ step: 3, steps: [{ title: "a", status: "done" }, { title: "b", status: "done" },
                                                      { title: "c", status: "done" }, { title: "d", status: "running" }] }))
        waitForRendering(c.overlay)
        compare(findChild(c.overlay, "cuSteps").count, 4)
        compare(findChild(c.overlay, "cuStatus").text, "Jarvis is controlling the screen · step 3 of 50")
        c.session.applyState({ active: false })
        waitForRendering(c.overlay)
        verify(!findChild(c.overlay, "cuBorder").visible)
    }

    function test_arabicMirrorsThePanelAndTranslates() {
        verify(testLanguage.setLanguage("ar"))
        const c = make(state({}))
        const panel = findChild(c.overlay, "cuPanel")
        verify(panel.x + panel.width < c.overlay.width / 2)  // trailing edge is the left in Arabic
        compare(c.overlay.inputRects[1].x, panel.x)
        compare(findChild(c.overlay, "cuStatus").text, "جارفيس يتحكم في الشاشة · الخطوة 2 من 50")
        compare(findChild(c.overlay, "cuTakeOver").text, "تولَّ التحكم (Esc)")
        compare(findChild(c.overlay, "cuApps").text, "")
    }
}
