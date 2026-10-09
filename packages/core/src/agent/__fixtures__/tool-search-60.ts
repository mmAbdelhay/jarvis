// Criterion 8's eval set: 60 tools and 30 prompts that are not in any tool
// description verbatim. Contract names; the test maps them with toModelName.
export const TOOLS: readonly { name: string; description: string }[] = [
  { name: "pkg.search", description: "Search APT and Flathub for apps and packages to install." },
  {
    name: "pkg.info",
    description: "Show details of one app or package: version, download size, installed or not.",
  },
  { name: "pkg.list_installed", description: "List the apps installed on this computer." },
  {
    name: "disk.usage",
    description: "Show disk space usage per filesystem and the largest folders.",
  },
  { name: "pkg.install", description: "Install apps or packages from APT or Flathub." },
  { name: "pkg.remove", description: "Remove (uninstall) apps or packages." },
  {
    name: "sys.health",
    description: "System health: uptime, load, memory, swap, disks, failed units, boot errors.",
  },
  {
    name: "logs.query",
    description: "Read system journal log lines, filtered by unit, priority, time and text.",
  },
  {
    name: "svc.status",
    description: "Status of one systemd service unit: active, sub-state, last log lines.",
  },
  { name: "svc.list_failed", description: "List systemd services that failed." },
  {
    name: "net.status",
    description:
      "Network status: NetworkManager, connectivity, devices, IP addresses, DNS, gateway.",
  },
  {
    name: "net.wifi_scan",
    description: "Scan for Wi-Fi (wifi) networks nearby and their signal strength.",
  },
  {
    name: "hw.info",
    description:
      "List hardware: PCI devices, graphics card, USB devices, drivers and firmware errors.",
  },
  {
    name: "svc.restart",
    description:
      "Restart a system or user service (systemd unit) such as NetworkManager, bluetooth or cups.",
  },
  { name: "net.connection_up", description: "Bring a saved network connection up." },
  {
    name: "net.wifi_connect",
    description:
      "Join a Wi-Fi (wifi) network by its name (SSID); the password is asked on the card.",
  },
  { name: "net.radio_on", description: "Turn the Wi-Fi radio on when it is switched off." },
  {
    name: "updates.list",
    description: "List pending system and app updates, marking security updates.",
  },
  { name: "updates.apply", description: "Apply (install) pending updates." },
  {
    name: "registry.search",
    description: "Search the Jarvis tool registry for add-on tool servers.",
  },
  {
    name: "registry.install",
    description: "Install an add-on tool server from the Jarvis registry.",
  },
  { name: "registry.remove", description: "Remove an installed add-on tool server." },
  {
    name: "files.search",
    description:
      "Search files in your home folder by name or content, for example documents and PDFs.",
  },
  { name: "files.preview", description: "Preview the text inside a file in your home folder." },
  {
    name: "web.fetch",
    description: "Fetch a web page or URL and return it as text, to read an article or page.",
  },
  { name: "clock.now", description: "Get the current local date, day and time." },
  {
    name: "clock.timer",
    description: "Set a countdown timer that rings after some minutes or seconds.",
  },
  {
    name: "weather.forecast",
    description: "Weather forecast for the coming days in a city: temperature, rain, wind.",
  },
  {
    name: "weather.current",
    description: "Current weather conditions outside in a city right now.",
  },
  {
    name: "calendar.list_events",
    description: "List events and appointments on your calendar for a day or week.",
  },
  {
    name: "calendar.add_event",
    description: "Add an event or appointment to your calendar at a date and time.",
  },
  { name: "notes.create", description: "Create a new note with a title and text." },
  { name: "notes.search", description: "Search your notes for words." },
  { name: "music.play", description: "Play music: a song, album, artist or playlist." },
  { name: "music.pause", description: "Pause or resume the music that is playing." },
  { name: "music.next_track", description: "Skip to the next track or song in the music queue." },
  {
    name: "volume.set",
    description: "Set the sound volume level in percent, louder or quieter, or mute.",
  },
  { name: "brightness.set", description: "Set the screen brightness level, brighter or dimmer." },
  { name: "screenshot.take", description: "Take a screenshot of the whole screen or one window." },
  { name: "clipboard.read", description: "Read the text currently on the clipboard." },
  { name: "clipboard.write", description: "Copy text to the clipboard." },
  { name: "todo.add", description: "Add an item to your todo list." },
  { name: "todo.list", description: "Show the items on your todo list." },
  { name: "email.list_unread", description: "List unread email messages in your inbox." },
  { name: "email.send", description: "Send an email message to a contact." },
  {
    name: "translate.text",
    description: "Translate text from one language into another, for example English into Arabic.",
  },
  {
    name: "dictionary.define",
    description: "Define a word: its meaning and examples from the dictionary.",
  },
  { name: "calculator.eval", description: "Calculate a math expression." },
  {
    name: "currency.convert",
    description: "Convert an amount of money between currencies such as dollars, euros and pounds.",
  },
  {
    name: "unit.convert",
    description:
      "Convert units of length, weight and temperature: miles, kilometers, kilograms, Fahrenheit.",
  },
  { name: "timezone.convert", description: "Show what time it is in another city or time zone." },
  { name: "battery.status", description: "Battery charge level and time left on battery power." },
  { name: "bluetooth.list_devices", description: "List paired and nearby Bluetooth devices." },
  {
    name: "bluetooth.connect",
    description: "Connect a paired Bluetooth device such as headphones or a speaker.",
  },
  { name: "printer.list", description: "List printers and their status." },
  { name: "printer.print_file", description: "Print a file such as a PDF document on a printer." },
  { name: "git.status", description: "Show the git status of a code repository folder." },
  {
    name: "docker.list_containers",
    description: "List Docker containers and whether they are running.",
  },
  { name: "docker.restart_container", description: "Restart a Docker container by name." },
  { name: "rss.read_feed", description: "Read the latest items from your RSS news feeds." },
];

export const PROMPTS: readonly { text: string; expect: string }[] = [
  { text: "What's the weather forecast for tomorrow in Cairo?", expect: "weather.forecast" },
  {
    text: "Add a dentist appointment to my calendar on Monday at 10",
    expect: "calendar.add_event",
  },
  { text: "What events do I have on my calendar this week?", expect: "calendar.list_events" },
  { text: "Take a screenshot of my screen", expect: "screenshot.take" },
  { text: "Play some music by Fairuz", expect: "music.play" },
  { text: "Skip to the next song", expect: "music.next_track" },
  { text: "Turn the volume down to 30 percent", expect: "volume.set" },
  { text: "Make the screen brighter", expect: "brightness.set" },
  { text: "Copy this text to the clipboard", expect: "clipboard.write" },
  { text: "Translate 'good morning' into Arabic", expect: "translate.text" },
  { text: "Define the word serendipity", expect: "dictionary.define" },
  { text: "Convert 100 dollars to euros", expect: "currency.convert" },
  { text: "How many kilometers is 10 miles?", expect: "unit.convert" },
  { text: "Set a timer for 10 minutes", expect: "clock.timer" },
  { text: "What's today's date?", expect: "clock.now" },
  { text: "Find my tax PDF in my documents", expect: "files.search" },
  { text: "Show me what's inside notes.txt in my home folder", expect: "files.preview" },
  { text: "Read the article at https://example.com/news/today", expect: "web.fetch" },
  { text: "Add buy milk to my todo list", expect: "todo.add" },
  { text: "Do I have any unread email?", expect: "email.list_unread" },
  { text: "Send an email to Sara saying I'm late", expect: "email.send" },
  { text: "How much battery is left?", expect: "battery.status" },
  { text: "Connect my bluetooth headphones", expect: "bluetooth.connect" },
  { text: "Print the report.pdf file", expect: "printer.print_file" },
  { text: "Which docker containers are running?", expect: "docker.list_containers" },
  { text: "Restart the docker container called web", expect: "docker.restart_container" },
  { text: "Restart the bluetooth service", expect: "svc.restart" },
  { text: "Join the wifi network called HomeNet", expect: "net.wifi_connect" },
  { text: "What graphics card and USB devices does this computer have?", expect: "hw.info" },
  { text: "How much disk space do my folders use?", expect: "disk.usage" },
];
