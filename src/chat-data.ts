export const chatOrder = [
  "chief",
  "sales",
  "inbox",
  "account",
  "talent",
  "expense",
  "offsite",
] as const;

export type ChatId = (typeof chatOrder)[number];

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

export interface Chat {
  id: ChatId;
  name: string;
  avatarClass: string;
  avatarText: string;
  preview: string;
  timestamp: string;
  messages: ReadonlyArray<Message>;
}

export type ChatCollection = Record<ChatId, Chat>;

export const initialChats: ChatCollection = {
  chief: {
    id: "chief",
    name: "Chief",
    avatarClass: "a-chief",
    avatarText: "C",
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
      { type: "outgoing", text: "book it", reaction: "👍" },
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
    id: "sales",
    name: "Sales Outbound",
    avatarClass: "a-sales",
    avatarText: "S",
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
    id: "inbox",
    name: "Inbox Manager",
    avatarClass: "a-inbox",
    avatarText: "I",
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
    id: "account",
    name: "Account Manager",
    avatarClass: "a-account",
    avatarText: "A",
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
    id: "talent",
    name: "Talent Scout",
    avatarClass: "a-talent",
    avatarText: "T",
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
    id: "expense",
    name: "Expense Manager",
    avatarClass: "a-expense",
    avatarText: "E",
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
    id: "offsite",
    name: "Offsite crew",
    avatarClass: "a-offsite",
    avatarText: "O",
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
