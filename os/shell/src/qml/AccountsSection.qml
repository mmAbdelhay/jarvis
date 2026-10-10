import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Settings → Accounts (Plan Y §1.4, §2.5): who is signed in, Sign out (the
// CLI's own logout, then its files are deleted) and Remove (signs out, then
// removes the program). Copilot's grant also lives at GitHub (spec §5.6).
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property AccountsModel accounts
    property string confirmingRemove: ""

    spacing: 12

    Text {
        Layout.fillWidth: true
        text: qsTr("Accounts you signed in with. Their sign-in stays inside each program's own folder on this computer; Jarvis never stores it.")
        wrapMode: Text.Wrap
        color: Theme.muted
    }

    Repeater {
        model: root.accounts
        delegate: Rectangle {
            id: row
            required property string account
            required property string label
            required property bool installed
            required property bool signedIn
            required property string statusText
            objectName: "accountRow_" + account
            Layout.fillWidth: true
            implicitHeight: rowLayout.implicitHeight + 24
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: Theme.border

            RowLayout {
                id: rowLayout
                anchors.fill: parent
                anchors.margins: 12
                spacing: 12
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text { text: row.label; textFormat: Text.PlainText; color: Theme.text; font.weight: Font.DemiBold }
                    Text { text: row.statusText; textFormat: Text.PlainText; color: Theme.muted; font.pixelSize: Theme.fontSmall; wrapMode: Text.Wrap; Layout.fillWidth: true }
                }
                ActionButton {
                    objectName: "accountRowSignOut_" + row.account
                    visible: row.signedIn
                    text: qsTr("Sign out")
                    onClicked: root.accounts.signOut(row.account)
                }
                ActionButton {
                    objectName: "accountRowRemove_" + row.account
                    visible: row.installed && root.confirmingRemove !== row.account
                    text: qsTr("Remove")
                    onClicked: root.confirmingRemove = row.account
                }
                ActionButton {
                    objectName: "accountRowConfirmRemove_" + row.account
                    visible: root.confirmingRemove === row.account
                    variant: "primary"
                    text: qsTr("Remove %1").arg(row.label)
                    onClicked: {
                        root.confirmingRemove = ""
                        root.accounts.remove(row.account)
                    }
                }
            }
        }
    }

    Text {
        objectName: "geminiRevokeNote"
        Layout.fillWidth: true
        text: qsTr("To revoke Google access after signing out, visit https://myaccount.google.com/connections.")
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.mutedSoft
        font.pixelSize: Theme.fontSmall
    }

    Text {
        objectName: "copilotRevokeNote"
        Layout.fillWidth: true
        visible: true
        text: qsTr("Signing out of GitHub Copilot deletes its sign-in data from this computer. To cancel its access completely, also remove \"GitHub Copilot CLI\" at github.com/settings/applications.")
        wrapMode: Text.Wrap
        color: Theme.mutedSoft
        font.pixelSize: Theme.fontSmall
    }
}
