import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Left rail (design: Install steps). Done steps can be revisited before
// Installing; the current and later steps cannot be clicked.
Rectangle {
    id: root
    required property var labels
    required property int current
    property bool locked: false
    signal picked(int index)

    implicitWidth: 320
    color: Theme.surfaceDeep
    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 28
        anchors.rightMargin: 28
        anchors.topMargin: 40
        anchors.bottomMargin: 40
        spacing: 28

        RowLayout {
            spacing: 10
            Icon { path: Icons.logo; color: Theme.accent; size: 26 }
            Text {
                objectName: "railTitle"
                text: "Install " + Brand.distroName
                textFormat: Text.PlainText
                color: Theme.text
                font.weight: Font.DemiBold
                font.letterSpacing: 0.6
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4
            Accessible.role: Accessible.List
            Accessible.name: "Install steps"
            Repeater {
                model: root.labels
                delegate: AbstractButton {
                    id: stepButton
                    required property string modelData
                    required property int index
                    readonly property bool done: index < root.current
                    readonly property bool here: index === root.current
                    objectName: "rail_" + index
                    Layout.fillWidth: true
                    implicitHeight: 46
                    enabled: done && !root.locked
                    Accessible.name: modelData + (here ? ", current step" : done ? ", done" : "")
                    onClicked: root.picked(index)
                    background: Rectangle {
                        radius: 10
                        color: stepButton.here ? Theme.surfaceRaised : "transparent"
                        Rectangle {
                            anchors.fill: parent
                            anchors.margins: -3
                            radius: 13
                            color: "transparent"
                            border.width: 2
                            border.color: Theme.accent
                            visible: stepButton.visualFocus
                        }
                    }
                    contentItem: RowLayout {
                        spacing: 12
                        Item { implicitWidth: 0 }
                        Rectangle {
                            implicitWidth: 26
                            implicitHeight: 26
                            radius: 13
                            color: "transparent"
                            border.color: stepButton.done || stepButton.here ? Theme.accent : Theme.stepPending
                            Text {
                                anchors.centerIn: parent
                                text: stepButton.done ? "✓" : String(stepButton.index + 1)
                                color: parent.border.color
                                font.family: Theme.mono
                                font.pixelSize: Theme.fontTiny
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            text: stepButton.modelData
                            color: stepButton.here ? Theme.text : stepButton.done ? Theme.textSoft : Theme.mutedSoft
                        }
                    }
                }
            }
        }
        Item { Layout.fillHeight: true }
    }
}
