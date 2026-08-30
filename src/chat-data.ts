export type ChatId = string;

export type WispShape =
  | "circle"
  | "pebble"
  | "triangle"
  | "cloud"
  | "square"
  | "pill"
  | "diamond"
  | "hexagon"
  | "drop";

export interface AgentSettings {
  id: string;
  name: string;
  label: string;
  description: string;
  color?: string;
  avatarImage?: string;
  shape: WispShape;
  isGroup: boolean;
  notifyOnUpdatesEnabled: boolean;
  isActive?: boolean;
  unread?: boolean;
}

interface TextMessage {
  type: "incoming" | "outgoing";
  text: string;
  time?: string;
  reactions?: ReadonlyArray<string>;
}

interface TimeMessage {
  type: "time";
  text: string;
}

interface CardMessage {
  type: "card";
  items: ReadonlyArray<{ label: string; text: string }>;
}

interface PromptMessage {
  type: "prompt";
  question: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  answer?: string;
}

export type Message = TextMessage | TimeMessage | CardMessage | PromptMessage;

export interface Chat extends AgentSettings {
  preview: string;
  timestamp: string;
  messages: ReadonlyArray<Message>;
}

export type ChatCollection = Record<ChatId, Chat>;

export const initialChats: ChatCollection = {
  chief: {
    id: "chief",
    name: "Chief of Staff",
    label: "Operations",
    description: "Coordinates priorities and keeps work moving.",
    color: "#e5484d",
    shape: "square",
    isGroup: false,
    notifyOnUpdatesEnabled: true,
    isActive: true,
    preview: "booked the venue and sent the confirmation…",
    timestamp: "Yesterday",
    messages: [
      {
        type: "card",
        items: [
          { label: "Deck", text: "numbers checked against finance's sheet · 2 stale slides flagged" },
          { label: "Offsite", text: "3 venues shortlisted · dates held on each" },
        ],
      },
      {
        type: "incoming",
        text: "two things need you today: the deck review at 2pm, and a yes/no on the venue. everything else is handled.",
        time: "12:41 AM",
      },
      { type: "time", text: "Yesterday 12:59 AM" },
      { type: "outgoing", text: "take the venue, i'll do the deck", time: "12:59 AM" },
      {
        type: "incoming",
        text: "the marina house is the pick: seats all 40, the mid-week rate came in 15% under budget, and they'll hold the date until tomorrow.",
        time: "1:23 AM",
      },
      { type: "time", text: "Yesterday 1:59 AM" },
      { type: "outgoing", text: "book it", time: "1:59 AM" },
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
        time: "2:08 AM",
        reactions: ["👍 1"],
      },
    ],
  },
  sales: {
    id: "sales", name: "Sales Outbound", label: "Sales", description: "Qualifies opportunities and prepares follow-ups.",
    color: "#8b70f6", shape: "hexagon", isGroup: false, notifyOnUpdatesEnabled: true, isActive: true,
    preview: "120 accounts sequenced, 3 meetings booked.", timestamp: "Yesterday",
    messages: [{ type: "incoming", text: "done. 120 accounts sequenced, 14 replies, 3 meetings booked for next week.", time: "4:12 PM" }],
  },
  inbox: {
    id: "inbox", name: "Inbox Manager", label: "Admin", description: "Triages incoming messages and drafts responses.",
    color: "#8e8e8e", shape: "circle", isGroup: false, notifyOnUpdatesEnabled: true, unread: true,
    preview: "sent. inbox at zero, 5 drafts parked…", timestamp: "Yesterday",
    messages: [{ type: "incoming", text: "sent. inbox at zero, 5 drafts parked for your review.", time: "3:48 PM" }],
  },
  account: {
    id: "account", name: "Account Manager", label: "Success", description: "Monitors account activity and customer requests.",
    color: "#f59e0b", shape: "pill", isGroup: false, notifyOnUpdatesEnabled: true, isActive: true,
    preview: "invite's out to vicky. globex note heads…", timestamp: "Yesterday",
    messages: [{ type: "incoming", text: "invite's out to vicky. globex note heads to finance monday.", time: "2:31 PM" }],
  },
  talent: {
    id: "talent", name: "Talent Scout", label: "People", description: "Supports recruiting and candidate coordination.",
    color: "#ff309b", shape: "drop", isGroup: false, notifyOnUpdatesEnabled: true,
    preview: "3 intros drafted in your voice, held…", timestamp: "Yesterday",
    messages: [{ type: "incoming", text: "3 intros drafted in your voice, held for sign-off.", time: "1:45 PM" }],
  },
  expense: {
    id: "expense", name: "Expense Manager", label: "Finance", description: "Reviews receipts and prepares expense reports.",
    color: "#00c972", shape: "diamond", isGroup: false, notifyOnUpdatesEnabled: true,
    preview: "report filed. 9 receipts, nothing out…", timestamp: "Yesterday",
    messages: [{ type: "incoming", text: "report filed. 9 receipts, nothing out of policy.", time: "12:18 PM" }],
  },
  offsite: {
    id: "offsite", name: "Offsite Crew", label: "Channel", description: "Plans the company offsite and coordinates logistics.",
    color: "#4a9eff", shape: "circle", isGroup: true, notifyOnUpdatesEnabled: true,
    preview: "that leaves the pipeline. i'd spin up…", timestamp: "Yesterday",
    messages: [{ type: "incoming", text: "that leaves the pipeline. i'd spin up the retreat channel next.", time: "11:52 AM" }],
  },
};
