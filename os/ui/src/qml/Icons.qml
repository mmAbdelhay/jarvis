pragma Singleton
import QtQuick

// 24x24 stroke icons, path data copied from the design artboards.
QtObject {
    readonly property string logo: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"
    readonly property string chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"
    readonly property string activity: "M3 12h4l3-8 4 16 3-8h4"
    readonly property string settings: "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
    readonly property string terminal: "M5 8l4 4-4 4 M12 16h7"
    readonly property string offline: "M2 8.5a15 15 0 0 1 20 0 M5.5 12a10 10 0 0 1 13 0 M9 15.5a5 5 0 0 1 6 0 M3 3L21 21"
    readonly property string shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"
    readonly property string send: "M12 19V5 M5 12l7-7 7 7"
    readonly property string check: "M20 6L9 17l-5-5"
    readonly property string stop: "M7 7h10v10H7z"
    readonly property string power: "M12 3v9 M6.3 6.3a8 8 0 1 0 11.4 0"
    readonly property string accessibility: "M10.5 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0 M5 8l7 1.5L19 8 M12 9.5V14l-3 6 M12 14l3 6"
    readonly property string arrowRight: "M5 12h14 M12 5l7 7-7 7"
    readonly property string done: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M8 12.5l3 3 5-6"
    readonly property string download: "M12 4v11 M7 10l5 5 5-5 M5 20h14"
    readonly property string rings: "M1 12a11 11 0 1 0 22 0a11 11 0 1 0 -22 0 M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"
    readonly property string mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5 11a7 7 0 0 0 14 0 M12 18v3"
    readonly property string lock: "M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4"
    readonly property string undo: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3"
    readonly property string phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M11 18h2"
    readonly property string speaker: "M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a8 8 0 0 1 0 11"
    readonly property string apps: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z"
    readonly property string folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
    readonly property string wifi: "M2 8.5a15 15 0 0 1 20 0 M5.5 12a10 10 0 0 1 13 0 M9 15.5a5 5 0 0 1 6 0 M12 19h.01"
}
