import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Greeter

TestCase {
    id: testCase
    name: "LoginScreen"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component { id: screenComponent; LoginScreen {} }
    Component { id: spyComponent; SignalSpy {} }
    readonly property string ready: '{"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"ready","percent":100}'

    function make(options, state) {
        const login = harness.fresh(options || {})
        const status = harness.status(state === undefined ? ready : state)
        const s = createTemporaryObject(screenComponent, testCase,
                                        { login: login, modelStatus: status, width: 1440, height: 900 })
        waitForRendering(s)
        return { login: login, s: s }
    }
    function type(text) {
        for (const ch of text)
            keyClick(ch)
    }
    function cleanup() { Theme.textScale = 1.0 }

    function test_layoutPerDesign() {
        const c = make()
        compare(findChild(c.s, "clock").text, Qt.formatTime(new Date(), "HH:mm"))
        compare(findChild(c.s, "avatarInitial").text, "M")
        compare(findChild(c.s, "name").text, "Mohamed Abdelhay")
        compare(findChild(c.s, "statusText").text, "Jarvis is ready · Qwen3 8B loaded")
        verify(Qt.colorEqual(findChild(c.s, "statusDot").color, Theme.accent))
        compare(findChild(c.s, "keyboardButton").text, "EN")
        compare(findChild(c.s, "submitButton").Accessible.name, "Log in")
        if (harness.screenshotDir.length > 0)
            grabImage(c.s).save(harness.screenshotDir + "/login.png")
    }

    function test_focusStartsInThePasswordField() {
        const c = make()
        const field = findChild(c.s, "passwordField")
        tryCompare(field, "activeFocus", true)
        compare(field.echoMode, TextInput.Password)
        compare(field.placeholderText, "Password")
    }

    function test_enterLogsIn() {
        const c = make()
        const started = createTemporaryObject(spyComponent, testCase, { target: c.login, signalName: "sessionStarted" })
        tryCompare(findChild(c.s, "passwordField"), "activeFocus", true)
        type("right horse")
        keyClick(Qt.Key_Return)
        tryCompare(started, "count", 1)
        compare(harness.requestTypes(), ["create_session", "post_auth_message_response", "start_session"])
    }

    function test_wrongPasswordShowsErrorAndClearsTheField() {
        const c = make()
        const field = findChild(c.s, "passwordField")
        tryCompare(field, "activeFocus", true)
        type("nope")
        mouseClick(findChild(c.s, "submitButton"))
        tryCompare(c.login, "state", "idle")
        compare(findChild(c.s, "errorText").text, "That password didn't work. Try again.")
        compare(field.text, "")
        tryCompare(field, "activeFocus", true)
    }

    function test_extraPromptReplacesThePlaceholder() {
        const c = make({ extraPrompt: "Verification code:" })
        tryCompare(findChild(c.s, "passwordField"), "activeFocus", true)
        type("right horse")
        keyClick(Qt.Key_Return)
        tryCompare(c.login, "state", "prompt")
        const field = findChild(c.s, "passwordField")
        compare(field.placeholderText, "Verification code:")
        compare(field.echoMode, TextInput.Normal)
        compare(field.text, "")
    }

    function test_otherUserShowsAUsernameField() {
        const c = make()
        verify(!findChild(c.s, "usernameField").visible)
        mouseClick(findChild(c.s, "otherUser"))
        verify(findChild(c.s, "usernameField").visible)
        compare(findChild(c.s, "otherUser").text, "Back to Mohamed Abdelhay")
        compare(findChild(c.s, "avatarInitial").text, "?")
    }

    function test_preparingAndHiddenStatus() {
        const c = make({}, '{"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"downloading","percent":42}')
        compare(findChild(c.s, "statusText").text, "Preparing Qwen3 8B · 42%")
        verify(Qt.colorEqual(findChild(c.s, "statusDot").color, Theme.approval))
        const none = make({}, "")
        verify(!findChild(none.s, "statusText").visible)
    }

    function test_largeTextToggle() {
        const c = make()
        const toggle = findChild(c.s, "largeText")
        mouseClick(toggle)
        verify(toggle.checked)
        compare(Theme.textScale, 1.25)
        mouseClick(toggle)
        compare(Theme.textScale, 1.0)
    }

    function test_powerMenu() {
        const c = make()
        mouseClick(findChild(c.s, "powerButton"))
        const menu = findChild(c.s, "powerMenu")
        tryCompare(menu, "opened", true)
        compare(menu.itemAt(0).text, "Shut down")
        mouseClick(menu.itemAt(1))                    // "Restart"
        compare(harness.powerCalls(), ["Reboot"])
    }
}
