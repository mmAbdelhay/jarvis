import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// The installer surface (design: Installer.dc.html, 1440×900): step rail,
// the current screen (max 780 px), refusal / error notices, Back and Next.
Rectangle {
    id: root
    required property InstallerModel installer

    color: Theme.bg

    RowLayout {
        anchors.fill: parent
        spacing: 0

        StepRail {
            Layout.fillHeight: true
            labels: root.installer.stepLabels
            current: root.installer.step
            locked: root.installer.step >= 5 || root.installer.busy
            onPicked: (i) => root.installer.goTo(i)
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.leftMargin: 72
            Layout.rightMargin: 72
            Layout.topMargin: 56
            Layout.bottomMargin: 40
            spacing: 16

            Flickable {
                id: flick
                Layout.fillWidth: true
                Layout.maximumWidth: 780
                Layout.fillHeight: true
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                contentHeight: views.height
                readonly property Item currentScreen: views.children[views.currentIndex] ?? null
                ScrollBar.vertical: ScrollBar {}

                StackLayout {
                    id: views
                    objectName: "views"
                    width: flick.width
                    height: Math.max(flick.height, flick.currentScreen ? flick.currentScreen.implicitHeight : 0)
                    currentIndex: root.installer.step
                    onCurrentIndexChanged: flick.contentY = 0

                    WelcomeScreen { installer: root.installer }
                    DiskScreen { installer: root.installer }
                    AccountScreen { installer: root.installer }
                    BrainScreen { installer: root.installer }
                    ReviewScreen { installer: root.installer }
                    InstallingScreen { installer: root.installer }
                    DoneScreen { installer: root.installer }
                }
            }

            Card {
                objectName: "refusalNotice"
                Layout.fillWidth: true
                Layout.maximumWidth: 780
                tone: "approval"
                visible: root.installer.refusalText.length > 0
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 12
                    Icon { Layout.alignment: Qt.AlignTop; path: Icons.shield; color: Theme.approval; strokeWidth: 2; size: 20 }
                    Text {
                        objectName: "refusalText"
                        Layout.fillWidth: true
                        text: root.installer.refusalText
                        textFormat: Text.PlainText
                        color: Theme.text
                        wrapMode: Text.Wrap
                    }
                }
            }
            Text {
                objectName: "errorNotice"
                Layout.fillWidth: true
                Layout.maximumWidth: 780
                visible: text.length > 0 && root.installer.probed
                text: root.installer.errorText
                textFormat: Text.PlainText
                color: Theme.warn
                wrapMode: Text.Wrap
            }

            Rectangle { Layout.fillWidth: true; Layout.maximumWidth: 780; implicitHeight: 1; color: Theme.border }
            RowLayout {
                Layout.fillWidth: true
                Layout.maximumWidth: 780
                Layout.topMargin: 8
                spacing: 16
                ActionButton {
                    objectName: "backButton"
                    implicitHeight: 48
                    variant: "ghost"
                    text: "Back"
                    enabled: root.installer.backVisible
                    opacity: root.installer.backVisible ? 1 : 0
                    onClicked: root.installer.back()
                }
                Text {
                    objectName: "blockText"
                    Layout.fillWidth: true
                    visible: root.installer.step >= 1 && root.installer.step <= 3
                    text: root.installer.blockText
                    textFormat: Text.PlainText
                    horizontalAlignment: Text.AlignRight
                    color: Theme.mutedSoft
                    font.pixelSize: Theme.fontSmall
                    wrapMode: Text.Wrap
                }
                Item { Layout.fillWidth: true; visible: !(root.installer.step >= 1 && root.installer.step <= 3) }
                ActionButton {
                    objectName: "nextButton"
                    implicitHeight: 48
                    text: root.installer.nextLabel
                    variant: root.installer.nextVariant
                    enabled: root.installer.canContinue
                    onClicked: root.installer.next()
                }
            }
        }
    }
}
