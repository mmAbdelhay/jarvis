import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Step 3 (design: "Your account"). With encryption on, the account password
// also unlocks the disk unless the person asks for a separate passphrase.
ColumnLayout {
    id: root
    required property InstallerModel installer
    readonly property AccountChoice account: installer.account

    spacing: 20

    ScreenTitle {
        Layout.fillWidth: true
        title: "Your account"
        subtitle: "This password unlocks the computer and approves high-risk changes, such as adding users or touching disks."
    }

    GridLayout {
        Layout.fillWidth: true
        columns: 2
        columnSpacing: 16
        rowSpacing: 16
        LabeledField {
            objectName: "fullName"
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            label: "Your name"
            value: root.account.fullName
            onEdited: (v) => root.account.fullName = v
        }
        LabeledField {
            objectName: "hostname"
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            label: "Computer name"
            mono: true
            value: root.account.hostname
            onEdited: (v) => root.account.hostname = v
        }
        LabeledField {
            objectName: "username"
            Layout.fillWidth: true
            label: "Username"
            mono: true
            value: root.account.username
            onEdited: (v) => root.account.username = v
        }
        Item { Layout.fillWidth: true }
        LabeledField {
            objectName: "password"
            Layout.fillWidth: true
            label: "Password"
            secret: true
            value: root.account.password
            onEdited: (v) => root.account.password = v
        }
        LabeledField {
            objectName: "confirm"
            Layout.fillWidth: true
            label: "Confirm password"
            secret: true
            value: root.account.confirm
            onEdited: (v) => root.account.confirm = v
        }
    }

    Text {
        objectName: "nameProblems"
        Layout.fillWidth: true
        visible: text.length > 0
        text: [root.account.usernameProblem, root.account.hostnameProblem].filter((t) => t.length > 0).join("\n")
        textFormat: Text.PlainText
        color: Theme.warn
        font.pixelSize: Theme.fontSmall
        wrapMode: Text.Wrap
    }
    Text {
        objectName: "passwordStatus"
        Layout.fillWidth: true
        visible: text.length > 0
        text: root.account.passwordStatus
        textFormat: Text.PlainText
        color: root.account.passwordOk ? Theme.accentHover : Theme.warn
        font.pixelSize: Theme.fontSmall
    }

    CheckRow {
        objectName: "autologin"
        Layout.fillWidth: true
        text: "Log in automatically (not recommended on a laptop)"
        checked: root.account.autologin
        onToggled: {
            root.account.autologin = checked
            checked = Qt.binding(() => root.account.autologin)
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: root.account.encrypt
        spacing: 12
        CheckRow {
            objectName: "diskSame"
            Layout.fillWidth: true
            text: "Use this password to unlock the disk at start"
            checked: root.account.diskSameAsPassword
            onToggled: {
                root.account.diskSameAsPassword = checked
                checked = Qt.binding(() => root.account.diskSameAsPassword)
            }
        }
        GridLayout {
            Layout.fillWidth: true
            visible: !root.account.diskSameAsPassword
            columns: 2
            columnSpacing: 16
            LabeledField {
                objectName: "diskPassphrase"
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                label: "Disk passphrase"
                secret: true
                value: root.account.diskPassphrase
                onEdited: (v) => root.account.diskPassphrase = v
            }
            LabeledField {
                objectName: "diskConfirm"
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                label: "Confirm disk passphrase"
                secret: true
                value: root.account.diskConfirm
                onEdited: (v) => root.account.diskConfirm = v
            }
        }
        Text {
            objectName: "diskStatus"
            Layout.fillWidth: true
            visible: !root.account.diskSameAsPassword && text.length > 0
            text: root.account.diskStatus
            textFormat: Text.PlainText
            color: root.account.diskOk ? Theme.accentHover : Theme.warn
            font.pixelSize: Theme.fontSmall
        }
    }
}
