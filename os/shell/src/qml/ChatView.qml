import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Chat (design: Main): a centred 760 px column of user bubbles, plain
// assistant text, mono tool lines and notices; the confirm card sits below
// the last message; the composer is pinned at the bottom.
Item {
    id: root
    required property Conversation conversation
    required property CardModel card
    signal submit(string text)
    signal stopRequested()
    signal decided(bool approve)

    function focusComposer() { composer.focusInput() }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        ListView {
            id: list
            objectName: "messages"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: root.conversation
            spacing: 20
            topMargin: 28
            bottomMargin: 20
            boundsBehavior: Flickable.StopAtBounds
            readonly property real columnWidth: Math.max(200, Math.min(760, width - 80))
            ScrollBar.vertical: ScrollBar {}

            function follow() { Qt.callLater(list.positionViewAtEnd) }
            onCountChanged: follow()
            Connections {
                target: root.conversation
                function onDataChanged() { list.follow() }
            }

            delegate: Loader {
                id: entry
                required property string kind
                required property string text
                required property string toolName
                required property string toolStatus
                required property string changeFrom
                required property string changeTo

                x: (list.width - list.columnWidth) / 2
                width: list.columnWidth
                sourceComponent: kind === "user" ? userBubble
                               : kind === "tool" ? toolLine
                               : kind === "notice" ? notice
                               : assistantText

                Component {
                    id: userBubble
                    Item {
                        readonly property string text: entry.text
                        implicitHeight: bubble.height
                        Rectangle {
                            id: bubble
                            anchors.right: parent.right
                            width: Math.min(label.implicitWidth + 32, parent.width * 0.7)
                            height: label.implicitHeight + 20
                            radius: 14
                            color: Theme.surfaceRaised
                            Text {
                                id: label
                                anchors.fill: parent
                                anchors.margins: 10
                                anchors.leftMargin: 16
                                anchors.rightMargin: 16
                                text: entry.text
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: Theme.textSoft
                            }
                        }
                    }
                }
                Component {
                    id: assistantText
                    TextEdit {
                        text: entry.text
                        textFormat: TextEdit.PlainText
                        readOnly: true
                        selectByMouse: true
                        wrapMode: TextEdit.Wrap
                        color: Theme.text
                        selectionColor: Theme.accentTintBorder
                        font.pixelSize: Theme.fontSize
                    }
                }
                Component {
                    id: toolLine
                    RowLayout {
                        readonly property string text: entry.text
                        spacing: 10
                        Text {
                            objectName: "toolGlyph"
                            text: entry.toolStatus === "ok" ? "✓" : entry.toolStatus === "error" ? "✕" : "…"
                            color: entry.toolStatus === "error" ? Theme.warn : Theme.accent
                            font.family: Theme.mono
                            font.pixelSize: Theme.fontSmall
                        }
                        Text {
                            Layout.minimumWidth: 104
                            text: entry.toolName
                            textFormat: Text.PlainText
                            color: Theme.textSoft
                            font.family: Theme.mono
                            font.pixelSize: Theme.fontSmall
                        }
                        Text {
                            Layout.fillWidth: true
                            text: entry.text
                            textFormat: Text.PlainText
                            visible: entry.changeFrom === ""
                            color: Theme.muted
                            elide: Text.ElideRight
                            font.family: Theme.mono
                            font.pixelSize: Theme.fontSmall
                        }
                        ChangeValue {
                            objectName: "toolChange"
                            Layout.fillWidth: true
                            visible: entry.changeFrom !== ""
                            from: entry.changeFrom
                            to: entry.changeTo
                            pixelSize: Theme.fontSmall
                        }
                    }
                }
                Component {
                    id: notice
                    Text {
                        text: entry.text
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.mutedSoft
                        font.pixelSize: Theme.fontSmall
                    }
                }
            }

            footer: Item {
                width: list.width
                height: chatCard.visible ? chatCard.height + 20 : 0
                ConfirmCard {
                    id: chatCard
                    objectName: "chatCard"
                    card: root.card
                    x: (list.width - list.columnWidth) / 2
                    y: 20
                    width: list.columnWidth
                    onDecided: (approve) => root.decided(approve)
                    onVisibleChanged: if (visible) list.follow()
                }
            }
        }

        Composer {
            id: composer
            Layout.fillWidth: true
            Layout.maximumWidth: 760
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: 16
            Layout.bottomMargin: 18
            Layout.leftMargin: 40
            Layout.rightMargin: 40
            busy: root.conversation.busy
            onSubmit: (text) => root.submit(text)
            onStopRequested: root.stopRequested()
        }
    }
}
