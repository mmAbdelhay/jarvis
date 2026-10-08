import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// A masked input for a card secret (e.g. a Wi-Fi password). Its value goes to
// CardModel.setSecret and from there straight to the tool through jarvisd's
// RiskGate; the model never sees it.
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    property string label
    readonly property alias field: input
    signal edited(string value)

    spacing: 6

    Text {
        text: root.label
        textFormat: Text.PlainText
        color: Theme.approvalMuted
        font.pixelSize: Theme.fontSmall
    }
    TextField {
        id: input
        objectName: "input"
        Layout.fillWidth: true
        implicitHeight: Theme.controlHeight
        leftPadding: 14
        rightPadding: 14
        echoMode: TextInput.Password
        passwordCharacter: "•"
        inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase | Qt.ImhHiddenText
        color: Theme.text
        font.pixelSize: Theme.fontSize
        Accessible.name: root.label
        background: Rectangle {
            radius: Theme.radiusControl
            color: Theme.bg
            border.color: input.activeFocus ? Theme.approval : Theme.approvalButtonBorder
        }
        onTextEdited: root.edited(text)
    }
    Text {
        text: qsTr("Goes straight to the system. Jarvis's model never sees it.")
        color: Theme.approvalMuted
        font.pixelSize: Theme.fontTiny
    }
}
