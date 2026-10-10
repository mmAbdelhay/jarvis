import QtQuick
import Jarvis.UI
import QtTest
import Jarvis.Shell

TestCase {
    id: testCase
    name: "AccountPanel"
    when: windowShown
    visible: true
    width: 1100
    height: 900

    Component {
        id: formComponent
        ProviderForm {
            provider: ProviderModel {}
            accounts: AccountsModel {}
        }
    }
    Component { id: spyComponent; SignalSpy {} }

    function makeForm() {
        const form = createTemporaryObject(formComponent, testCase, { width: 900 })
        const provider = form.provider
        const accounts = form.accounts
        waitForRendering(form)
        return { provider: provider, accounts: accounts, form: form }
    }

    function test_fourthModeShowsFourTextTiles() {
        const c = makeForm()
        mouseClick(findChild(c.form, "mode_account"))
        compare(c.provider.mode, "account")
        for (const id of ["claude", "chatgpt", "gemini", "copilot"])
            verify(findChild(c.form, "account_" + id).visible)
        compare(findChild(c.form, "account_gemini").title, "Google")
        verify(!findChild(c.form, "apiKey").visible)
        verify(!findChild(c.form, "checkButton").visible) // not signed in yet
    }

    function test_noAccountTileWithoutTheModel() {
        const form = createTemporaryObject(formComponent, testCase, { accounts: null, width: 900 })
        waitForRendering(form)
        verify(findChild(form, "mode_account") === null || !findChild(form, "mode_account").visible)
    }

    function test_signInInstallsFirst() {
        const c = makeForm()
        c.provider.mode = "account"
        waitForRendering(c.form)
        mouseClick(findChild(c.form, "account_chatgpt"))
        compare(c.accounts.selected, "chatgpt")
        const installs = createTemporaryObject(spyComponent, testCase, { target: c.accounts, signalName: "installRequested" })
        mouseClick(findChild(c.form, "accountSignIn"))
        compare(installs.count, 1)
        compare(installs.signalArguments[0][0], "chatgpt")
        verify(c.accounts.busy)
    }

    function test_showsTheAddressAndCode() {
        const c = makeForm()
        c.provider.mode = "account"
        c.provider.account = "copilot"
        c.accounts.applyState({ account: "copilot", phase: "awaiting-browser", url: "https://github.com/login/device", code: "WDJB-MJHT" })
        waitForRendering(c.form)
        verify(findChild(c.form, "accountBrowser").visible)
        compare(findChild(c.form, "accountUrl").text, "https://github.com/login/device")
        compare(findChild(c.form, "accountCode").text, "WDJB-MJHT")
        verify(findChild(c.form, "accountCopy").visible)
        verify(findChild(c.form, "accountOpen").visible)
    }

    function test_signedInShowsIdentityAndSignOut() {
        const c = makeForm()
        c.provider.mode = "account"
        c.accounts.applyState({ account: "claude", phase: "signed-in", identity: "sara@example.com" })
        waitForRendering(c.form)
        compare(findChild(c.form, "accountStatusText").text, "Signed in as sara@example.com")
        verify(findChild(c.form, "accountSignOut").visible)
        verify(!findChild(c.form, "accountSignIn").visible)
        verify(findChild(c.form, "checkButton").visible)
        const outs = createTemporaryObject(spyComponent, testCase, { target: c.accounts, signalName: "logoutRequested" })
        mouseClick(findChild(c.form, "accountSignOut"))
        compare(outs.count, 1)
    }

    function test_signOutShowsRevocationGuidance_data() {
        return [
            { tag: "google", account: "gemini", url: "https://myaccount.google.com/connections" },
            { tag: "copilot", account: "copilot", url: "https://github.com/settings/applications" }
        ]
    }

    function test_signOutShowsRevocationGuidance(data) {
        const c = makeForm()
        c.provider.mode = "account"
        c.provider.account = data.account
        c.accounts.applyState({ account: data.account, phase: "signed-in", identity: "sara@example.com" })
        waitForRendering(c.form)
        mouseClick(findChild(c.form, "accountSignOut"))
        verify(findChild(c.form, "accountStatusText").text.includes(data.url))
    }

    function test_theAddressIsLeftAlignedText() {
        const c = makeForm()
        c.provider.mode = "account"
        c.accounts.applyState({ account: "claude", phase: "awaiting-browser", url: "https://claude.ai/oauth/authorize" })
        const field = findChild(c.form, "accountUrl")
        compare(field.horizontalAlignment, TextInput.AlignLeft)
        verify(field.readOnly)
    }
}
