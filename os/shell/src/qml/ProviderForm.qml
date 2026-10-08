import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Where the model runs (design: Setup): cloud preset + API key, Ollama on this
// computer, or a server on the network; a connection check; the privacy note
// the spec requires (§4: diagnosis sends redacted log excerpts to the provider).
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property ProviderModel provider

    spacing: 24

    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        Repeater {
            model: [
                { id: "cloud", title: qsTr("Cloud"), detail: qsTr("Strongest models. Needs internet and an API key.") },
                { id: "local", title: qsTr("This computer"), detail: qsTr("Private and offline. Uses your memory and GPU.") },
                { id: "lan", title: qsTr("Network server"), detail: qsTr("A stronger PC at home or work runs the model.") }
            ]
            delegate: ChoiceTile {
                required property var modelData
                objectName: "mode_" + modelData.id
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                title: modelData.title
                detail: modelData.detail
                selected: root.provider.mode === modelData.id
                onClicked: root.provider.mode = modelData.id
            }
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: root.provider.mode === "cloud"
        spacing: 18
        GridLayout {
            Layout.fillWidth: true
            columns: 4
            columnSpacing: 8
            rowSpacing: 8
            Repeater {
                model: root.provider.presetNames
                delegate: ChoiceTile {
                    required property string modelData
                    objectName: "preset_" + modelData
                    Layout.fillWidth: true
                    Layout.preferredWidth: 1
                    compact: true
                    // Preset IDs stay in English; only the custom option has a UI label.
                    title: modelData === "Custom URL" ? qsTr("Custom URL") : modelData // i18n: ignore
                    selected: root.provider.preset === modelData
                    onClicked: root.provider.preset = modelData
                }
            }
        }
        LabeledField {
            objectName: "customUrl"
            Layout.fillWidth: true
            visible: root.provider.preset === "Custom URL" // i18n: ignore
            label: qsTr("Base URL (OpenAI-compatible)")
            mono: true
            placeholder: "https://example.com/v1"
            value: root.provider.baseUrl
            onEdited: (v) => root.provider.baseUrl = v
        }
        LabeledField {
            objectName: "apiKey"
            Layout.fillWidth: true
            label: qsTr("API key")
            secret: true
            placeholder: root.provider.activeHasKey ? qsTr("Saved. Leave empty to keep it.") : ""
            value: root.provider.apiKey
            onEdited: (v) => root.provider.apiKey = v
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: root.provider.mode === "local"
        spacing: 12
        LabeledField {
            objectName: "ollamaUrl"
            Layout.fillWidth: true
            label: qsTr("Ollama address")
            mono: true
            value: root.provider.baseUrl
            onEdited: (v) => root.provider.baseUrl = v
        }
        Text {
            Layout.fillWidth: true
            text: qsTr("Jarvis connects to an Ollama that is already running on this computer. Nothing leaves this machine.")
            color: Theme.muted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.Wrap
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: root.provider.mode === "lan"
        spacing: 12
        RowLayout {
            spacing: 8
            ChoiceTile {
                objectName: "lanKind_ollama"
                compact: true
                implicitWidth: 140
                title: qsTr("Ollama")
                selected: root.provider.kind === "ollama"
                onClicked: root.provider.kind = "ollama"
            }
            ChoiceTile {
                objectName: "lanKind_openai"
                compact: true
                implicitWidth: 200
                title: qsTr("OpenAI-compatible")
                selected: root.provider.kind === "openai-compatible"
                onClicked: root.provider.kind = "openai-compatible"
            }
        }
        LabeledField {
            objectName: "lanUrl"
            Layout.fillWidth: true
            label: qsTr("Server address (Ollama, LM Studio or vLLM)")
            mono: true
            placeholder: "http://192.168.1.20:11434"
            value: root.provider.baseUrl
            onEdited: (v) => root.provider.baseUrl = v
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 6
        Text {
            text: qsTr("Model")
            color: Theme.muted
            font.pixelSize: Theme.fontSmall
        }
        ComboBox {
            id: picker
            objectName: "modelPicker"
            Layout.fillWidth: true
            implicitHeight: Theme.controlHeight
            model: root.provider.models
            enabled: count > 0
            displayText: root.provider.model.length > 0 ? root.provider.model : qsTr("Models load after the connection check")
            onActivated: (i) => root.provider.model = root.provider.models[i]
            Accessible.name: qsTr("Model")
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        ActionButton {
            objectName: "checkButton"
            visible: root.provider.probeState === "idle"
            variant: "ghost"
            text: qsTr("Check connection")
            onClicked: root.provider.probe()
        }
        Rectangle {
            id: status
            objectName: "probeStatus"
            Layout.fillWidth: true
            visible: root.provider.probeState !== "idle"
            implicitHeight: statusRow.implicitHeight + 28
            radius: 12
            readonly property bool good: root.provider.probeState === "ok"
            readonly property bool bad: root.provider.probeState === "warn" || root.provider.probeState === "error"
            color: good ? Theme.accentTint : bad ? Theme.approvalCard : Theme.surface
            border.color: good ? Theme.accentTintBorder : bad ? Theme.approvalBorder : Theme.borderStrong
            RowLayout {
                id: statusRow
                anchors.fill: parent
                anchors.margins: 14
                anchors.leftMargin: 16
                spacing: 12
                Icon {
                    path: status.good ? Icons.check : Icons.shield
                    color: status.good ? Theme.accent : Theme.approval
                    strokeWidth: 2
                    size: 20
                }
                Text {
                    objectName: "probeText"
                    Layout.fillWidth: true
                    text: root.provider.statusText
                    textFormat: Text.PlainText
                    color: Theme.text
                    wrapMode: Text.Wrap
                }
                ActionButton {
                    visible: root.provider.probeState !== "probing" && root.provider.probeState !== "saving"
                    variant: "ghost"
                    implicitHeight: 36
                    text: qsTr("Test again")
                    onClicked: root.provider.probe()
                }
            }
        }
    }

    Text {
        objectName: "privacyText"
        Layout.fillWidth: true
        text: root.provider.privacyText
        color: Theme.mutedSoft
        font.pixelSize: Theme.fontSmall
        wrapMode: Text.Wrap
    }
}
