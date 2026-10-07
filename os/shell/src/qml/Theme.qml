pragma Singleton
import QtQuick

// Design tokens from the approved Jarvis OS artboards (Main, ConfirmBatch,
// Setup, Doctor, Audit). Views never hard-code a colour.
QtObject {
    readonly property color bg: "#0D1014"
    readonly property color surfaceDeep: "#0B0E12"
    readonly property color surface: "#151A20"
    readonly property color surfaceRaised: "#1C222A"
    readonly property color border: "#222932"
    readonly property color borderStrong: "#2A323C"
    readonly property color text: "#E7EAEE"
    readonly property color textSoft: "#C9CFD6"
    readonly property color muted: "#9AA4B1"
    readonly property color mutedSoft: "#8A94A1"

    readonly property color accent: "#4FD8C4"
    readonly property color accentHover: "#8BE9DA"
    readonly property color accentInk: "#062A25"
    readonly property color accentTint: "#10201D"
    readonly property color accentTintBorder: "#1F4A43"
    readonly property color accentTintText: "#CFEFEA"

    readonly property color approval: "#F2B33D"
    readonly property color approvalInk: "#1A1300"
    readonly property color approvalCard: "#1A1710"
    readonly property color approvalBorder: "#3A3220"
    readonly property color approvalDivider: "#2A2618"
    readonly property color approvalMuted: "#B8AE98"
    readonly property color approvalButtonBorder: "#5A5240"

    readonly property color warn: "#FB923C"
    readonly property color warnBannerBg: "#22170C"
    readonly property color warnBannerBorder: "#4A3218"
    readonly property color warnBannerText: "#FDD9B5"
    readonly property color failedChipBg: "#2A1A10"
    readonly property color failedChipText: "#FDBA8C"
    readonly property color tableHeader: "#11161B"

    readonly property string sans: "IBM Plex Sans"
    readonly property string mono: "IBM Plex Mono"
    readonly property int fontSize: 15
    readonly property int fontSmall: 13
    readonly property int fontTiny: 12

    readonly property int radiusCard: 14
    readonly property int radiusControl: 10
    readonly property int controlHeight: 44
}
