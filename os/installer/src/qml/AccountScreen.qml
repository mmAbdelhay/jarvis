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
        title: qsTr("Your account")
        subtitle: qsTr("This password unlocks the computer and approves high-risk changes, such as adding users or touching disks.")
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
            label: qsTr("Your name")
            value: root.account.fullName
            onEdited: (v) => root.account.fullName = v
        }
        LabeledField {
            objectName: "hostname"
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            label: qsTr("Computer name")
            mono: true
            value: root.account.hostname
            onEdited: (v) => root.account.hostname = v
        }
        LabeledField {
            objectName: "username"
            Layout.fillWidth: true
            label: qsTr("Username")
            mono: true
            value: root.account.username
            onEdited: (v) => root.account.username = v
        }
        Item { Layout.fillWidth: true }
        LabeledField {
            objectName: "password"
            Layout.fillWidth: true
            label: qsTr("Password")
            secret: true
            value: root.account.password
            onEdited: (v) => root.account.password = v
        }
        LabeledField {
            objectName: "confirm"
            Layout.fillWidth: true
            label: qsTr("Confirm password")
            secret: true
            value: root.account.confirm
            onEdited: (v) => root.account.confirm = v
        }
    }

    Text {
        // The live session types with the chosen layout when it could be
        // applied; otherwise warn before a password is set (contracts §11.5).
        objectName: "keyboardNote"
        readonly property LocaleChoice locale: root.installer.locale
        readonly property string chosen: locale.keyboardName(locale.keyboard)
        readonly property string typing: locale.keyboardName(locale.typingKeyboard)
        Layout.fillWidth: true
        text: locale.typingMatches
            ? qsTr("You're typing with the %1 keyboard. Use the same layout to unlock the disk and sign in.").arg(chosen)
            : qsTr("You're typing with the %1 keyboard right now, but %2 will use %3. Keys that differ between them will type different characters when you unlock the disk and sign in. Use only letters and digits that sit in the same place on both keyboards, or go back and choose %1.").arg(typing).arg(Brand.distroName).arg(chosen)
        textFormat: Text.PlainText
        color: locale.typingMatches ? Theme.muted : Theme.warn
        font.pixelSize: Theme.fontSmall
        wrapMode: Text.Wrap
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
        text: qsTr("Log in automatically (not recommended on a laptop)")
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
            text: qsTr("Use this password to unlock the disk at start")
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
                label: qsTr("Disk passphrase")
                secret: true
                value: root.account.diskPassphrase
                onEdited: (v) => root.account.diskPassphrase = v
            }
            LabeledField {
                objectName: "diskConfirm"
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                label: qsTr("Confirm disk passphrase")
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
