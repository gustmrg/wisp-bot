export type ChatId = string;

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface AgentSettings {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  isGroup: boolean;
  notifyOnUpdatesEnabled: boolean;
  [key: string]: unknown;
}

export const chatOrder: ReadonlyArray<ChatId> = [
  "chief",
  "sales",
  "inbox",
  "account",
  "talent",
  "expense",
  "offsite",
];

interface TextMessage {
  type: "incoming" | "outgoing";
  text: string;
  reaction?: string;
}

interface TimeMessage {
  type: "time";
  text: string;
}

interface CardMessage {
  type: "card";
  items: ReadonlyArray<{
    label: string;
    text: string;
  }>;
}

export type Message = TextMessage | TimeMessage | CardMessage;

export interface Chat extends AgentSettings {
  color?: string;
  preview: string;
  timestamp: string;
  messages: ReadonlyArray<Message>;
}

export type ChatCollection = Record<ChatId, Chat>;

export const initialChats: ChatCollection = {
  chief: {
    description: "Coordinates priorities and keeps work moving.",
    id: "chief",
    isGroup: false,
    name: "Chief",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "booked the venue and sent the con…",
    timestamp: "Yesterday",
    messages: [
      {
        type: "card",
        items: [
          {
            label: "Deck",
            text: "numbers checked against finance's sheet · 2 stale slides flagged",
          },
          {
            label: "Offsite",
            text: "3 venues shortlisted · dates held on each",
          },
        ],
      },
      {
        type: "incoming",
        text: "two things need you today: the deck review at 2pm, and a yes/no on the venue. everything else is handled.",
      },
      { type: "time", text: "Yesterday 12:59 AM" },
      { type: "outgoing", text: "take the venue, i'll do the deck" },
      {
        type: "incoming",
        text: "the marina house is the pick: seats all 40, the mid-week rate came in 15% under budget, and they'll hold the date until tomorrow.",
      },
      { type: "time", text: "Yesterday 1:59 AM" },
      { type: "outgoing", text: "book it" },
      {
        type: "card",
        items: [
          { label: "Venue", text: "marina house booked · deposit paid" },
          { label: "Calendar", text: "invites updated for all 40" },
          { label: "Holds", text: "other two released with a thank-you" },
        ],
      },
      {
        type: "incoming",
        text: "booked the venue and sent the confirmation around. you're clear until the 2pm deck review.",
      },
    ],
  },
  sales: {
    description: "Qualifies opportunities and prepares sales follow-ups.",
    id: "sales",
    isGroup: false,
    name: "Sales Outbound",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "Done.",
    timestamp: "Yesterday",
    messages: [
      {
        type: "incoming",
        text: "done. 120 accounts sequenced, 14 replies, 3 meetings booked for next week.",
      },
    ],
  },
  inbox: {
    description: "Triages incoming messages and drafts responses.",
    id: "inbox",
    isGroup: false,
    name: "Inbox Manager",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "sent. inbox at zero, 5 drafts parked …",
    timestamp: "Yesterday",
    messages: [
      {
        type: "incoming",
        text: "sent. inbox at zero, 5 drafts parked for your review.",
      },
    ],
  },
  account: {
    description: "Monitors account activity and customer requests.",
    id: "account",
    isGroup: false,
    name: "Account Manager",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "invite's out to vicky. globex note he…",
    timestamp: "Yesterday",
    messages: [
      {
        type: "incoming",
        text: "invite's out to vicky. globex note heads to finance monday.",
      },
    ],
  },
  talent: {
    description: "Supports recruiting and candidate coordination.",
    id: "talent",
    isGroup: false,
    name: "Talent Scout",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "3 intros drafted in your voice, held …",
    timestamp: "Yesterday",
    messages: [
      {
        type: "incoming",
        text: "3 intros drafted in your voice, held for sign-off.",
      },
    ],
  },
  expense: {
    description: "Reviews receipts and prepares expense reports.",
    id: "expense",
    isGroup: false,
    name: "Expense Manager",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "report filed. 9 receipts, nothing out…",
    timestamp: "Yesterday",
    messages: [
      {
        type: "incoming",
        text: "report filed. 9 receipts, nothing out of policy.",
      },
    ],
  },
  offsite: {
    description: "Plans offsites and coordinates event logistics.",
    id: "offsite",
    isGroup: false,
    name: "Offsite crew",
    notifyOnUpdatesEnabled: true,
    provider: "openai",
    model: "gpt-5.6-terra",
    preview: "that leaves the pipeline. i'd spin up …",
    timestamp: "Yesterday",
    messages: [
      {
        type: "incoming",
        text: "that leaves the pipeline. i'd spin up the retreat channel next.",
      },
    ],
  },
};
