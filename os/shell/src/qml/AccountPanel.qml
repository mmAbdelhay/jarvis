import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Plan Y §2.5: "Sign in with an account" — four text tiles (no vendor logos),
// progress, the sign-in address with Copy and Open browser, the device code,
// who is signed in, and Sign out. Jarvis never asks for the password: the
// vendor's own page does.
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property ProviderModel provider
    required property AccountsModel accounts

    spacing: 16

    Binding {
        target: root.accounts
        property: "selected"
        value: root.provider.account
    }

    GridLayout {
        Layout.fillWidth: true
        columns: 4
        columnSpacing: 8
        rowSpacing: 8
        Repeater {
            model: ["claude", "chatgpt", "gemini", "copilot"]
            delegate: ChoiceTile {
                required property string modelData
                objectName: "account_" + modelData
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                compact: true
                title: root.accounts.labelFor(modelData) // vendor names stay as they are
                selected: root.provider.account === modelData
                enabled: !root.accounts.busy
                onClicked: root.provider.account = modelData
            }
        }
    }

    Rectangle {
        objectName: "accountStatus"
        Layout.fillWidth: true
        implicitHeight: statusRow.implicitHeight + 28
        radius: 12
        color: root.accounts.phase === "failed" ? Theme.approvalCard
             : root.accounts.selectedSignedIn ? Theme.accentTint : Theme.surface
        border.color: root.accounts.phase === "failed" ? Theme.approvalBorder
                    : root.accounts.selectedSignedIn ? Theme.accentTintBorder : Theme.borderStrong
        RowLayout {
            id: statusRow
            anchors.fill: parent
            anchors.margins: 14
            spacing: 12
            Icon {
                path: root.accounts.selectedSignedIn ? Icons.check : Icons.shield
                color: root.accounts.selectedSignedIn ? Theme.accent : Theme.muted
                size: 20
            }
            Text {
                objectName: "accountStatusText"
                Layout.fillWidth: true
                text: root.accounts.statusLine
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: Theme.text
            }
            ActionButton {
                objectName: "accountSignIn"
                visible: !root.accounts.selectedSignedIn && !root.accounts.busy
                variant: "primary"
                text: root.accounts.selectedInstalled ? qsTr("Sign in") : qsTr("Set up and sign in")
                onClicked: root.accounts.signIn()
            }
            ActionButton {
                objectName: "accountSignOut"
                visible: root.accounts.selectedSignedIn
                variant: "ghost"
                text: qsTr("Sign out")
                onClicked: root.accounts.signOut(root.accounts.selected)
            }
        }
    }

    ColumnLayout {
        objectName: "accountBrowser"
        Layout.fillWidth: true
        visible: root.accounts.phase === "awaiting-browser"
        spacing: 10
        Text {
            Layout.fillWidth: true
            text: root.accounts.code.length > 0
                  ? qsTr("Open this address, enter the code below and sign in. Your browser should already show it.")
                  : qsTr("Finish signing in in your browser. If it didn't open, open this address:")
            wrapMode: Text.Wrap
            color: Theme.muted
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            TextField {
                objectName: "accountUrl"
                Layout.fillWidth: true
                LayoutMirroring.enabled: false // an address always reads left to right
                readOnly: true
                selectByMouse: true
                text: root.accounts.url
                font.family: Theme.mono
                font.pixelSize: Theme.fontSmall
                color: Theme.text
                horizontalAlignment: TextInput.AlignLeft
                background: Rectangle { radius: Theme.radiusControl; color: Theme.surfaceDeep; border.color: Theme.borderStrong }
            }
            ActionButton {
                objectName: "accountCopy"
                text: qsTr("Copy")
                onClicked: root.accounts.copyToClipboard(root.accounts.url)
            }
            ActionButton {
                objectName: "accountOpen"
                variant: "primary"
                text: qsTr("Open browser")
                onClicked: root.accounts.openInBrowser()
            }
        }
        RowLayout {
            visible: root.accounts.code.length > 0
            spacing: 12
            Text { text: qsTr("Code"); color: Theme.muted }
            Text {
                objectName: "accountCode"
                LayoutMirroring.enabled: false
                text: root.accounts.code
                textFormat: Text.PlainText
                font.family: Theme.mono
                font.pixelSize: 28
                font.letterSpacing: 2
                color: Theme.text
            }
            ActionButton {
                objectName: "accountCopyCode"
                text: qsTr("Copy")
                onClicked: root.accounts.copyToClipboard(root.accounts.code)
            }
        }
    }
}
