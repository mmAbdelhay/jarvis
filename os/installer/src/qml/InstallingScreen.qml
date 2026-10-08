import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Step 6 (design: Installing). Current step with its percent, the step list,
// and the model download running in parallel. On failure: the step, the
// backend's message (plain text) and Restart (the footer button).
ColumnLayout {
    id: root
    required property InstallerModel installer
    readonly property InstallProgress progress: installer.progress

    function mark(state) {
        return state === "done" ? "✓" : state === "running" ? "…" : state === "failed" ? "✕" : "·"
    }
    function markColor(state) {
        return state === "done" ? Theme.accent : state === "failed" ? Theme.warn : state === "running" ? Theme.text : Theme.muted
    }

    spacing: 24

    ScreenTitle {
        Layout.fillWidth: true
        title: root.progress.failed ? qsTr("Installation stopped") : qsTr("Installing")
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: !root.progress.failed
        spacing: 8
        RowLayout {
            Layout.fillWidth: true
            Text {
                objectName: "currentTitle"
                Layout.fillWidth: true
                text: root.progress.currentTitle.length > 0 ? root.progress.currentTitle : qsTr("Starting…")
                textFormat: Text.PlainText
                color: Theme.text
                font.pixelSize: 14
                elide: Text.ElideRight
            }
            Text {
                objectName: "currentPercent"
                text: root.progress.currentPercent + "%" + (root.progress.currentDetail.length > 0 ? " · " + root.progress.currentDetail : "")
                textFormat: Text.PlainText
                color: Theme.muted
                font.family: Theme.mono
                font.pixelSize: 14
            }
        }
        Meter {
            objectName: "currentMeter"
            Layout.fillWidth: true
            fraction: root.progress.currentPercent / 100
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 8
        Repeater {
            model: root.progress.rows
            delegate: RowLayout {
                required property var modelData
                spacing: 8
                Text {
                    objectName: "mark_" + modelData.stepId
                    text: root.mark(modelData.state)
                    color: root.markColor(modelData.state)
                    font.family: Theme.mono
                    font.pixelSize: Theme.fontSmall
                }
                Text {
                    objectName: "step_" + modelData.stepId
                    text: modelData.title
                    textFormat: Text.PlainText
                    color: modelData.state === "pending" ? Theme.muted : Theme.text
                    font.family: Theme.mono
                    font.pixelSize: Theme.fontSmall
                }
            }
        }
        ColumnLayout {
            objectName: "modelRow"
            Layout.fillWidth: true
            visible: root.progress.modelVisible
            spacing: 6
            RowLayout {
                spacing: 8
                Text {
                    text: root.progress.modelPercent >= 100 ? "✓" : "…"
                    color: root.progress.modelPercent >= 100 ? Theme.accent : Theme.text
                    font.family: Theme.mono
                    font.pixelSize: Theme.fontSmall
                }
                Text {
                    objectName: "modelText"
                    text: root.progress.modelTitle + (root.progress.modelDetail.length > 0 ? " · " + root.progress.modelDetail : "")
                    textFormat: Text.PlainText
                    color: Theme.text
                    font.family: Theme.mono
                    font.pixelSize: Theme.fontSmall
                }
            }
            Meter {
                objectName: "modelMeter"
                Layout.preferredWidth: 320
                implicitHeight: 4
                fraction: root.progress.modelPercent / 100
            }
        }
    }

    Card {
        objectName: "failure"
        Layout.fillWidth: true
        tone: "approval"
        visible: root.progress.failed
        Text {
            objectName: "failTitle"
            Layout.fillWidth: true
            text: root.progress.failTitle
            textFormat: Text.PlainText
            color: Theme.text
            font.weight: Font.DemiBold
            wrapMode: Text.Wrap
        }
        // Contracts §10: Finished(false) carries the last 20 redacted log lines.
        Flickable {
            objectName: "failLog"
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(failMessage.implicitHeight, 240)
            contentHeight: failMessage.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            Text {
                id: failMessage
                objectName: "failMessage"
                width: parent.width
                text: root.progress.failMessage
                textFormat: Text.PlainText
                color: Theme.textSoft
                font.family: Theme.mono
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.Wrap
            }
        }
        Text {
            Layout.fillWidth: true
            text: qsTr("Nothing more will be changed. Some disk changes may already be done: restart and run the installer again, or start your other system.")
            color: Theme.approvalMuted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.Wrap
        }
    }

    Card {
        objectName: "whileYouWait"
        Layout.fillWidth: true
        visible: !root.progress.failed
        Text { text: qsTr("While you wait"); color: Theme.text; font.weight: Font.DemiBold }
        Text {
            Layout.fillWidth: true
            text: qsTr("After restart, try “set up this machine for Python and Docker”, or “why is my battery draining?”. Anything that changes the system shows a card first.")
            color: Theme.textSoft
            wrapMode: Text.Wrap
        }
    }
}
