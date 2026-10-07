import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Step 4 (design: "Jarvis's brain"). Cloud keys are entered after first login,
// never here. The M4 "tiny backup model" line is not shown in M2.
ColumnLayout {
    id: root
    required property InstallerModel installer
    readonly property BrainChoice brain: installer.brain

    spacing: 20

    ScreenTitle {
        Layout.fillWidth: true
        title: "Jarvis's brain"
    }

    Card {
        objectName: "facts"
        Layout.fillWidth: true
        padding: 14
        RowLayout {
            spacing: 24
            Repeater {
                model: [{ k: "Memory", v: root.brain.ramText }, { k: "GPU", v: root.brain.gpuText },
                        { k: "Free disk", v: root.brain.freeText }]
                delegate: RowLayout {
                    required property var modelData
                    spacing: 6
                    Text { text: modelData.k; color: Theme.muted; font.pixelSize: 14 }
                    Text {
                        objectName: "fact_" + modelData.k
                        text: modelData.v
                        textFormat: Text.PlainText
                        color: Theme.text
                        font.pixelSize: 14
                    }
                }
            }
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 10
        Accessible.role: Accessible.Grouping
        Accessible.name: "Where the model runs"

        ChoiceTile {
            objectName: "kind_local"
            Layout.fillWidth: true
            title: root.brain.localTitle
            detail: root.brain.localDetail
            badge: root.brain.localAvailable ? "Recommended" : ""
            enabled: root.brain.localAvailable
            selected: root.brain.kind === "local"
            onClicked: root.brain.kind = "local"
        }
        ColumnLayout {
            objectName: "modelList"
            Layout.fillWidth: true
            Layout.leftMargin: 24
            visible: root.brain.kind === "local" && root.brain.models.length > 1
            spacing: 8
            Text { text: "Models that fit this computer"; color: Theme.muted; font.pixelSize: Theme.fontSmall }
            Repeater {
                model: root.brain.models
                delegate: ChoiceTile {
                    required property var modelData
                    objectName: "model_" + modelData.id
                    Layout.fillWidth: true
                    title: modelData.title
                    detail: modelData.detail
                    badge: modelData.recommended ? "Recommended" : ""
                    selected: root.brain.modelId === modelData.id
                    onClicked: root.brain.modelId = modelData.id
                }
            }
        }
        ChoiceTile {
            objectName: "kind_cloud"
            Layout.fillWidth: true
            title: "Cloud provider"
            detail: "Strongest models. Enter an API key after the first login."
            selected: root.brain.kind === "cloud"
            onClicked: root.brain.kind = "cloud"
        }
        ChoiceTile {
            objectName: "kind_lan"
            Layout.fillWidth: true
            title: "Network server"
            detail: "Use a model running on another computer at home or work."
            selected: root.brain.kind === "lan"
            onClicked: root.brain.kind = "lan"
        }
        GridLayout {
            Layout.fillWidth: true
            visible: root.brain.kind === "lan"
            columns: 2
            columnSpacing: 16
            LabeledField {
                objectName: "lanUrl"
                Layout.fillWidth: true
                Layout.preferredWidth: 2
                label: "Server address (Ollama, LM Studio or vLLM)"
                mono: true
                placeholder: "http://192.168.1.20:11434"
                value: root.brain.lanUrl
                onEdited: (v) => root.brain.lanUrl = v
            }
            LabeledField {
                objectName: "lanModel"
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                label: "Model"
                mono: true
                placeholder: "qwen3:8b"
                value: root.brain.lanModel
                onEdited: (v) => root.brain.lanModel = v
            }
        }
    }

    Text {
        objectName: "footNote"
        Layout.fillWidth: true
        text: "You can add a cloud provider later, too."
        color: Theme.mutedSoft
        font.pixelSize: Theme.fontSmall
        wrapMode: Text.Wrap
    }
}
