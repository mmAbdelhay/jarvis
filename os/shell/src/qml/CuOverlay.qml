import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Rafiq v1.1 design §2.3, §3.3 (ComputerUse.dc.html): while Jarvis controls
// the screen, a teal border runs round every output; the primary output also
// shows the status pill (Take over / Resume / Stop) and the step panel.
// Only the pill and the panel take clicks: CuOverlayManager makes the
// window's input region from inputRects, so every other click reaches the app.
// Contract §4: this surface can appear in captures. Never render private
// goals, app names, step titles, or daemon errors, including accessibility text.
Item {
    id: root
    required property CuSessionModel session
    property bool primary: true
    readonly property int borderWidth: 4
    readonly property bool showChrome: primary && (session?.visible ?? false)
    readonly property var inputRects: showChrome
        ? [Qt.rect(pill.x, pill.y, pill.width, pill.height), Qt.rect(panel.x, panel.y, panel.width, panel.height)]
        : []

    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true

    Rectangle {
        objectName: "cuBorder"
        anchors.fill: parent
        visible: (root.session?.visible ?? false)
        color: "transparent"
        border.width: root.borderWidth
        border.color: Theme.accent
        opacity: (root.session?.running ?? false) ? 1 : 0.55
    }

    Rectangle {
        id: pill
        objectName: "cuPill"
        visible: root.showChrome
        anchors.top: parent.top
        anchors.topMargin: root.borderWidth + 12
        anchors.horizontalCenter: parent.horizontalCenter
        width: pillRow.implicitWidth + 28
        height: pillRow.implicitHeight + 16
        radius: height / 2
        color: Theme.surfaceRaised
        border.width: 1
        border.color: (root.session?.running ?? false) ? Theme.accent : Theme.approval
        Accessible.role: Accessible.AlertMessage
        Accessible.name: (root.session?.statusText ?? "")

        RowLayout {
            id: pillRow
            anchors.centerIn: parent
            spacing: 12

            Rectangle {
                Layout.preferredWidth: 10
                Layout.preferredHeight: 10
                radius: 5
                color: (root.session?.running ?? false) ? Theme.accent : Theme.approval
            }
            ColumnLayout {
                spacing: 0
                Text {
                    objectName: "cuStatus"
                    text: (root.session?.statusText ?? "")
                    textFormat: Text.PlainText
                    color: Theme.text
                    font.pixelSize: Theme.fontSize
                    font.weight: Font.Medium
                }
                Text {
                    objectName: "cuDetail"
                    visible: text.length > 0
                    text: (root.session?.paused ?? false) ? root.session.detailText : ""
                    textFormat: Text.PlainText
                    color: (root.session?.paused ?? false) ? Theme.approvalMuted : Theme.warn
                    font.pixelSize: Theme.fontTiny
                }
            }
            ActionButton {
                objectName: "cuTakeOver"
                visible: (root.session?.running ?? false)
                enabled: !(root.session?.busy ?? false)
                text: qsTr("Take over (Esc)")
                onClicked: root.session.stop()
            }
            ActionButton {
                objectName: "cuResume"
                visible: (root.session?.paused ?? false) && !(root.session?.connectionLost ?? false)
                enabled: !(root.session?.busy ?? false)
                variant: "primary"
                text: qsTr("Resume")
                onClicked: root.session.resume()
            }
            ActionButton {
                objectName: "cuStop"
                visible: (root.session?.paused ?? false) && !(root.session?.connectionLost ?? false)
                enabled: !(root.session?.busy ?? false)
                text: qsTr("Stop")
                onClicked: root.session.stop()
            }
        }
    }

    Rectangle {
        id: panel
        objectName: "cuPanel"
        visible: root.showChrome
        anchors.top: pill.bottom
        anchors.topMargin: 12
        anchors.right: parent.right
        anchors.rightMargin: root.borderWidth + 20
        width: 340
        height: Math.min(panelColumn.implicitHeight + 28, root.height * 0.6)
        radius: Theme.radiusCard
        color: Theme.surface
        border.width: 1
        border.color: Theme.accentTintBorder
        clip: true

        ColumnLayout {
            id: panelColumn
            anchors.fill: parent
            anchors.margins: 14
            spacing: 8

            Text {
                objectName: "cuGoal"
                Layout.fillWidth: true
                text: qsTr("Screen control")
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                maximumLineCount: 3
                elide: Text.ElideRight
                color: Theme.text
                font.pixelSize: Theme.fontSize
                font.weight: Font.DemiBold
            }
            Text {
                objectName: "cuApps"
                Layout.fillWidth: true
                visible: false
                text: ""
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: Theme.muted
                font.pixelSize: Theme.fontSmall
            }
            Text {
                text: qsTr("Steps")
                color: Theme.mutedSoft
                font.pixelSize: Theme.fontTiny
                font.weight: Font.DemiBold
            }
            ListView {
                id: stepList
                objectName: "cuSteps"
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(contentHeight, 280)
                clip: true
                spacing: 6
                interactive: contentHeight > height
                model: root.session
                onCountChanged: positionViewAtEnd()
                delegate: RowLayout {
                    id: stepRow
                    required property int index
                    required property string status
                    required property string statusLabel
                    objectName: "cuStep_" + index
                    width: ListView.view.width
                    spacing: 10
                    Accessible.role: Accessible.ListItem
                    Accessible.name: qsTr("%1: %2").arg(statusLabel).arg(stepTitle.text)

                    Rectangle {
                        Layout.preferredWidth: 10
                        Layout.preferredHeight: 10
                        radius: 5
                        color: stepRow.status === "done" ? Theme.accent
                             : stepRow.status === "failed" ? Theme.warn : "transparent"
                        border.width: stepRow.status === "running" || stepRow.status === "pending" ? 2 : 0
                        border.color: stepRow.status === "running" ? Theme.accent : Theme.stepPending
                    }
                    Text {
                        id: stepTitle
                        objectName: "cuStepTitle_" + stepRow.index
                        Layout.fillWidth: true
                        text: qsTr("Step %1").arg(stepRow.index + 1)
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: stepRow.status === "pending" ? Theme.muted : Theme.text
                        font.pixelSize: Theme.fontSmall
                        font.weight: stepRow.status === "running" ? Font.DemiBold : Font.Normal
                    }
                    Text {
                        objectName: "cuStepStatus_" + stepRow.index
                        text: stepRow.statusLabel
                        textFormat: Text.PlainText
                        color: Theme.muted
                        font.pixelSize: Theme.fontSmall
                    }
                }
            }
            Text {
                objectName: "cuError"
                Layout.fillWidth: true
                visible: text.length > 0
                text: (root.session?.error ?? "").length > 0 ? qsTr("Screen control request failed.") : ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: Theme.warn
                font.pixelSize: Theme.fontSmall
            }
        }
    }
}
