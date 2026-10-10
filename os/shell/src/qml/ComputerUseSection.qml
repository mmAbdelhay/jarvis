import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Settings → Computer use (Rafiq v1.1 design §2.2, §2.6, §3.3). Off until the
// user turns it on for a provider that can see images. A provider whose
// endpoint is not on this computer first asks, once, to send screenshots.
// The protected apps are listed read-only (contracts §1).
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property CuSettingsModel settings
    spacing: 14

    Text {
        Layout.fillWidth: true
        text: qsTr("Jarvis can look at the screen and use the mouse and keyboard in apps you allow, for one task at a time. It's off until you turn it on for a model, and you can take over at any moment with Esc.")
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.muted
    }
    Text {
        objectName: "cuEmpty"
        visible: root.settings.known && root.settings.count === 0
        text: qsTr("No model providers yet.")
        color: Theme.muted
    }

    Repeater {
        model: root.settings
        delegate: Rectangle {
            id: row
            required property int index
            required property string providerId
            required property string name
            required property bool vision
            required property bool cuEnabled
            required property string reason
            required property string privacy
            objectName: "cuProvider_" + providerId
            Layout.fillWidth: true
            implicitHeight: rowColumn.implicitHeight + 24
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: rowColumn
                anchors.fill: parent
                anchors.margins: 12
                spacing: 6
                CheckRow {
                    objectName: "cuToggle_" + row.providerId
                    Layout.fillWidth: true
                    text: qsTr("Let %1 use the screen").arg(row.name)
                    checked: row.cuEnabled
                    enabled: row.vision && !root.settings.busy
                    onToggled: {
                        const want = checked
                        checked = Qt.binding(() => row.cuEnabled) // show jarvisd's answer, not the click
                        root.settings.setEnabled(row.index, want)
                    }
                }
                Text {
                    objectName: "cuReason_" + row.providerId
                    Layout.fillWidth: true
                    visible: !row.vision
                    text: row.reason
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: Theme.muted
                    font.pixelSize: Theme.fontSmall
                }
                Text {
                    objectName: "cuPrivacy_" + row.providerId
                    Layout.fillWidth: true
                    visible: row.vision
                    text: row.privacy
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: Theme.mutedSoft
                    font.pixelSize: Theme.fontSmall
                }
            }
        }
    }

    Rectangle {
        id: consent
        objectName: "cuConsent"
        Layout.fillWidth: true
        visible: root.settings.consentProviderId !== ""
        implicitHeight: consentColumn.implicitHeight + 32
        radius: Theme.radiusCard
        color: Theme.approvalCard
        border.color: Theme.approval
        Accessible.role: Accessible.Dialog
        Accessible.name: consentTitle.text
        onVisibleChanged: if (visible) cancelButton.forceActiveFocus(Qt.OtherFocusReason)

        ColumnLayout {
            id: consentColumn
            anchors.fill: parent
            anchors.margins: 16
            spacing: 10
            Text {
                id: consentTitle
                objectName: "cuConsentTitle"
                Layout.fillWidth: true
                text: qsTr("Send screenshots to %1?").arg(root.settings.consentProviderName)
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: Theme.text
                font.pixelSize: Theme.fontSize
                font.weight: Font.DemiBold
            }
            Text {
                objectName: "cuConsentBody"
                Layout.fillWidth: true
                text: qsTr("While Jarvis uses the screen, screenshots of the allowed windows are sent to %1. Other windows are blacked out, and screenshots are never saved.").arg(root.settings.consentProviderName)
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: Theme.approvalMuted
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                Item { Layout.fillWidth: true }
                ActionButton {
                    id: cancelButton
                    objectName: "cuConsentCancel"
                    variant: "quiet"
                    text: qsTr("Cancel")
                    enabled: !root.settings.busy
                    onClicked: root.settings.declineConsent()
                }
                ActionButton {
                    objectName: "cuConsentAllow"
                    variant: "approve"
                    enabled: !root.settings.busy
                    text: qsTr("Allow and turn on")
                    onClicked: root.settings.acceptConsent()
                }
            }
        }
    }

    Text {
        objectName: "cuNote"
        Layout.fillWidth: true
        visible: text.length > 0 || root.settings.busy
        text: root.settings.busy ? qsTr("Saving…") : root.settings.note
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.settings.busy ? Theme.muted : Theme.warn
        font.pixelSize: Theme.fontSmall
    }

    ColumnLayout {
        Layout.fillWidth: true
        Layout.topMargin: 8
        spacing: 6
        Text {
            text: qsTr("Never controlled")
            color: Theme.text
            font.weight: Font.DemiBold
        }
        Text {
            Layout.fillWidth: true
            text: qsTr("These are always protected and can't be removed.")
            wrapMode: Text.Wrap
            color: Theme.muted
            font.pixelSize: Theme.fontSmall
        }
        Repeater {
            model: root.settings.excludedApps
            delegate: RowLayout {
                id: excludedRow
                required property int index
                required property string modelData
                spacing: 10
                Rectangle {
                    Layout.preferredWidth: 6
                    Layout.preferredHeight: 6
                    radius: 3
                    color: Theme.mutedSoft
                }
                Text {
                    objectName: "cuExcluded_" + excludedRow.index
                    text: excludedRow.modelData
                    textFormat: Text.PlainText
                    color: Theme.textSoft
                }
            }
        }
    }
}
