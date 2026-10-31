// The single source of truth for the Privacy Policy and Terms pages.
// Edit this file, then run:  node tools/legal/build.mjs
// (CI runs it with --check and fails if site/privacy.html or site/terms.html are out of date.)
//
// TO ADD A NEW CONNECTION (Spotify, Slack, a bank, ...): add ONE entry to `connections` below, then rebuild.
// It appears in the privacy policy's "Connections" list and, if it sends data to a third party, in "Who we share with".

export const company = {
  // Fill these in before launch. The build prints a warning for every "[...]" left, and pages show a draft banner while `draft` is true.
  draft: true,
  legalName: "[LEGAL NAME OR BUSINESS ENTITY]",
  productName: "Danny",
  address: "[MAILING ADDRESS, Ontario, Canada]", // CASL requires a mailing address in marketing email
  privacyOfficer: "[NAME OF PERSON RESPONSIBLE FOR PRIVACY]", // PIPEDA requires someone accountable
  email: "hello@dannyassistant.com",
  governingLaw: "the laws of the Province of Ontario and the federal laws of Canada applicable there",
  hosting: "[HOSTING PROVIDER AND REGION]",
  updated: "2026-10-31",
};

// Things Danny keeps about you. Add a line when a new feature stores something.
export const collected = [
  ["Your account", "Name, email address and a salted, hashed password."],
  ["Waitlist", "If you join the list, your email address and the time you did."],
  ["Conversations", "What you and Danny say to each other. Stored encrypted."],
  ["Memory", "Facts and preferences Danny remembers about you. You can see them and delete them."],
  ["Tasks, goals and reminders", "What you ask Danny to track or remind you about."],
  ["Approvals and activity log", "A record of what Danny asked to do, what you approved, and what ran."],
  ["Usage and cost", "How much of the service you used, so we can bill and cap it."],
  ["Notification details", "If you turn on push notifications, the address your browser or phone gives us to reach you."],
];

// Every connection. `shares` = what leaves our servers when it's used. `access` = what Danny can do.
// `id` is only for ordering/anchors. Set `status: "planned"` to list something before it ships.
export const connections = [
  {
    id: "google-mail",
    name: "Gmail (Google)",
    access: "Read your mail and, only after you approve each one, send messages from your account.",
    scopes: "gmail.readonly, gmail.send",
    shares: "Search terms and message requests go to Google. Email content Danny reads is passed to our AI provider to answer you.",
    revoke: "Disconnect in Danny's Connections screen, or at myaccount.google.com/permissions.",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    access: "Read your events and add or change events after you approve.",
    scopes: "calendar.events",
    shares: "Event requests go to Google. Event details Danny reads are passed to our AI provider to answer you.",
    revoke: "Disconnect in Danny's Connections screen, or at myaccount.google.com/permissions.",
  },
  {
    id: "github",
    name: "GitHub",
    access: "Read only: review requests, assigned issues and your open pull requests.",
    scopes: "A personal access token you create and can revoke at any time.",
    shares: "Requests go to GitHub. Titles and status Danny reads are passed to our AI provider to answer you.",
    revoke: "Disconnect in Danny's Connections screen, or delete the token in your GitHub settings.",
  },
];

// Companies that handle data on our behalf or receive it when a feature is used.
export const processors = [
  { name: "Anthropic", why: "Runs the AI that reads your messages and writes Danny's replies, and runs web searches when you ask for something current.", data: "Your messages, relevant memory, and content from connected accounts Danny reads to answer you.", country: "United States", url: "https://www.anthropic.com/legal/privacy" },
  { name: "ElevenLabs", why: "Voice typing (speech to text) and Danny's voice in call mode.", data: "Your audio when you use the mic or call mode, and Danny's spoken replies as text.", country: "United States", url: "https://elevenlabs.io/privacy" },
  { name: "Google", why: "Sign-in and the Gmail and Calendar connections.", data: "What the connection needs, as listed under Connections.", country: "United States", url: "https://policies.google.com/privacy" },
  { name: "GitHub", why: "The GitHub connection.", data: "Requests made with the token you provide.", country: "United States", url: "https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement" },
  { name: "Open-Meteo", why: "Weather for the forecast and your briefing.", data: "The place name or location you ask about. No account details.", country: "Switzerland / EU", url: "https://open-meteo.com/en/terms" },
  { name: "Push notification services", why: "Delivering notifications you turned on (run by your browser or phone maker, such as Apple, Google or Mozilla).", data: "A short notification message.", country: "Varies", url: "" },
  { name: "Hosting provider", why: "Runs Danny's servers and stores the database and backups.", data: "Everything we store, encrypted as described below.", country: "[COUNTRY]", url: "" },
];
