import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Step 7 (design: Done). The footer's "Restart now" reboots through logind.
ColumnLayout {
    id: root
    required property InstallerModel installer

    spacing: 16

    Item { Layout.preferredHeight: 120 }
    Icon { path: Icons.done; color: Theme.accent; strokeWidth: 1.6; size: 48 }
    Text {
        objectName: "doneTitle"
        Layout.fillWidth: true
        text: Brand.distroName + " is installed"
        textFormat: Text.PlainText
        color: Theme.text
        font.pixelSize: Theme.fontTitle
        font.weight: Font.DemiBold
        wrapMode: Text.Wrap
    }
    Text {
        Layout.fillWidth: true
        text: "Remove the USB stick, then restart. Jarvis will greet you after you log in."
        color: Theme.muted
        wrapMode: Text.Wrap
    }
    Text {
        objectName: "modelLater"
        Layout.fillWidth: true
        visible: root.installer.progress.modelVisible && root.installer.progress.modelPercent < 100
        text: "Jarvis will finish downloading its model after the first start."
        color: Theme.muted
        wrapMode: Text.Wrap
    }
    Card {
        objectName: "finishNote"
        Layout.fillWidth: true
        tone: "approval"
        visible: root.installer.progress.finishNote.length > 0
        Text {
            Layout.fillWidth: true
            text: root.installer.progress.finishNote
            textFormat: Text.PlainText
            color: Theme.text
            wrapMode: Text.Wrap
        }
    }
}
