import QtQuick
import QtTest
import Jarvis.Greeter

TestCase {
    name: "GreeterRtl"
    when: windowShown
    visible: true
    width: 1440
    height: 900

    Component {
        id: screen
        LoginScreen {
            width: 1440
            height: 900
            language: harness.language()
        }
    }

    function cleanup() {
        if (harness.language().language === "ar") harness.language().toggle()
        testLanguage.setLanguage("en")
    }

    function test_chosenSessionAndLanguage() {
        const login = harness.fresh({sessionExec: 'jarvis-classic --chat'})
        const s = createTemporaryObject(screen, this, {login: login, modelStatus: harness.status("")})
        mouseClick(findChild(s, "languageButton"))
        login.submit("right horse")
        tryVerify(() => harness.startRequest().type === "start_session")
        compare(harness.startRequest().cmd, ["jarvis-classic", "--chat"])
        compare(harness.startRequest().env, ["LANG=ar_EG.UTF-8"])
    }

    function test_changingUserClearsTypedPassword() {
        const login = harness.fresh({offline: true})
        const s = createTemporaryObject(screen, this, {login: login, modelStatus: harness.status("")})
        const password = findChild(s, "passwordField")
        password.text = "unfinished"
        login.useOtherUser()
        compare(password.text, "")
    }

    function test_unavailableSessionExplainsWhyLoginCannotStart() {
        const login = harness.fresh({offline: true, sessionExec: ""})
        const s = createTemporaryObject(screen, this, {login: login, modelStatus: harness.status("")})
        login.submit("secret")
        compare(findChild(s, "errorText").text, "The selected session is unavailable.")
        compare(login.state, "idle")
        compare(harness.requestTypes().length, 0)
        mouseClick(findChild(s, "languageButton"))
        compare(findChild(s, "errorText").text, "الجلسة المحددة غير متاحة.")
    }

    function test_existingErrorRetranslates() {
        const login = harness.fresh({offline: true, users: false})
        const s = createTemporaryObject(screen, this, {login: login, modelStatus: harness.status("")})
        login.submit("secret")
        compare(findChild(s, "errorText").text, "Type your username.")
        mouseClick(findChild(s, "languageButton"))
        compare(findChild(s, "errorText").text, "اكتب اسم المستخدم.")
    }

    function test_toggleKeepsTypedPasswordAndUpdatesStatus() {
        const s = createTemporaryObject(screen, this, {login: harness.fresh({offline: true}), modelStatus: harness.status('{"state":"ready","modelId":"main","ollamaTag":"test"}')})
        const password = findChild(s, "passwordField")
        password.text = "unfinished"
        mouseClick(findChild(s, "languageButton"))
        compare(password.text, "unfinished")
        verify(findChild(s, "statusText").text.indexOf("جارفيس جاهز") === 0)
    }

    function test_toggleTranslatesAndMirrors() {
        const s = createTemporaryObject(screen, this, { login: harness.fresh({offline: true}), modelStatus: harness.status("") })
        compare(findChild(s, "submitButton").Accessible.name, "Log in")
        const power = findChild(s, "powerButton")
        verify(power.mapToItem(s, 0, 0).x > s.width / 2)

        mouseClick(findChild(s, "languageButton"))
        tryCompare(findChild(s, "submitButton").Accessible, "name", "تسجيل الدخول")
        compare(findChild(s, "passwordField").placeholderText, "كلمة المرور")
        compare(findChild(s, "otherUser").text, "مستخدم آخر")
        tryVerify(() => findChild(s, "powerButton").mapToItem(s, 0, 0).x < s.width / 2)
        compare(findChild(s, "languageButton").text, "English")

        mouseClick(findChild(s, "languageButton"))
        tryCompare(findChild(s, "submitButton").Accessible, "name", "Log in")
    }
}
