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
}
