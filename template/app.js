/* ===== Grok Bot recreation ===== */
"use strict";

/* ---------- helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtTime(d) {
  let h = d.getHours(), m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
function fmtSecs(d) {
  let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ${ap}`;
}
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dayLabel(d) {
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

/* ---------- avatars (inline SVG) ---------- */
function squircleAvatar(fg, bg, id) {
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="9" fill="${bg}"/><ellipse cx="12.4" cy="14.6" rx="2.5" ry="4" fill="${fg}" transform="rotate(-10 12.4 14.6)"/><ellipse cx="19.6" cy="14.6" rx="2.5" ry="4" fill="${fg}" transform="rotate(10 19.6 14.6)"/></svg>`;
}
function hexAvatar(fg, bg) {
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${HEX_BODY(bg)}<ellipse cx="12.6" cy="15.4" rx="2.3" ry="3.7" fill="${fg}" transform="rotate(-10 12.6 15.4)"/><ellipse cx="19.4" cy="15.4" rx="2.3" ry="3.7" fill="${fg}" transform="rotate(10 19.4 15.4)"/></svg>`;
}
function hashAvatar() {
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="9" fill="#2e2e2e"/><path d="M13.5 8l-2.5 16M21 8l-2.5 16M8.5 13h16M7.5 19h16" stroke="#9a9a9a" stroke-width="2" stroke-linecap="round"/></svg>`;
}
const AVATARS = {
  chief: () => squircleAvatar("#330f0d", "#e5484d"),
  newbot: () => hexAvatar("#241a3e", "#8b70f6"),
  channel: () => hashAvatar(),
};

/* ---------- configurable avatars (shape + color) ---------- */
const AVATAR_COLORS = [
  "#262626", "#8b6b52", "#e5484d", "#f0762b", "#eebb4d", "#35b06f",
  "#40c4aa", "#4a9eff", "#8b70f6", "#e5498f", "#8e8e8e",
];
const HEX_BODY = (c) => `<path d="M14.8 2.6a4 4 0 0 1 2.4 0l8.6 3.1a4 4 0 0 1 2.6 3.1l2 9.3a4 4 0 0 1-.9 3.9l-6.4 7.4a4 4 0 0 1-3 1.4h-8.2a4 4 0 0 1-3-1.4L2.5 22a4 4 0 0 1-.9-3.9l2-9.3a4 4 0 0 1 2.6-3.1z" fill="${c}"/>`;
const SHAPES = {
  circle: { label: "Circle", eyes: [[12.6, 15.2], [19.4, 15.2]], body: (c) => `<circle cx="16" cy="16" r="12.5" fill="${c}"/>` },
  egg: { label: "Egg", eyes: [[12.6, 15], [19.4, 15]], body: (c) => `<ellipse cx="16" cy="16" rx="13" ry="11.3" fill="${c}" transform="rotate(-8 16 16)"/>` },
  square: { label: "Square", eyes: [[12.4, 15], [19.6, 15]], body: (c) => `<rect x="4" y="4" width="24" height="24" rx="7.5" fill="${c}"/>` },
  pill: { label: "Pill", eyes: [[12.2, 15.2], [19.8, 15.2]], body: (c) => `<rect x="2.5" y="7.5" width="27" height="17" rx="8.5" fill="${c}"/>` },
  triangle: { label: "Triangle", eyes: [[13.4, 17.6], [18.6, 17.6]], body: (c) => `<path d="M16 6.4L27 25.2H5Z" fill="${c}" stroke="${c}" stroke-width="4.5" stroke-linejoin="round"/>` },
  hex: { label: "Hexagon", eyes: [[12.6, 15.4], [19.4, 15.4]], body: HEX_BODY },
  cloud: { label: "Cloud", eyes: [[13.6, 19.4], [19.4, 19.4]], body: (c) => `<g fill="${c}"><circle cx="10.5" cy="19.5" r="5.5"/><circle cx="16.5" cy="14.8" r="6.8"/><circle cx="22.5" cy="19.5" r="5.5"/><rect x="10.5" y="17" width="12" height="8"/></g>` },
  drop: { label: "Drop", eyes: [[12.9, 17.6], [19.1, 17.6]], body: (c) => `<path d="M16 4.2c3.6 5 9.4 10.3 9.4 15.3a9.4 9.4 0 1 1-18.8 0C6.6 14.5 12.4 9.2 16 4.2Z" fill="${c}"/>` },
};
function shapeAvatarSVG(shape, color) {
  const s = SHAPES[shape] || SHAPES.hex;
  const c = color || AVATAR_COLORS[8];
  const eyes = s.eyes.map(([x, y], i) =>
    `<ellipse cx="${x}" cy="${y}" rx="1.7" ry="2.9" fill="#fff" transform="rotate(${i === 0 ? -10 : 10} ${x} ${y})"/>`).join("");
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${s.body(c)}${eyes}</svg>`;
}

/* ---------- plugins data ---------- */
const P = (id, name, desc, cat, bg, glyph, fg = "#fff") => ({ id, name, desc, cat, bg, glyph, fg });
const PLUGINS = [
  P("gmail", "Gmail", "Search, read, draft, and manage email.", "Featured", "#fff", "M", "#ea4335"),
  P("google-calendar", "Google Calendar", "Search events and schedule meetings.", "Featured", "#fff", "31", "#1a73e8"),
  P("google-drive", "Google Drive", "Search, read, create, and share files.", "Featured", "#fff", "▲", "#0f9d58"),
  P("granola", "Granola", "Your meetings in your workflow. Granola gives Cursor...", "Featured", "#a3b465", "◎"),
  P("arize", "Arize", "Add Arize AX observability to LLM applications — aut...", "Agent Orchestration", "#e6119d", "▲"),
  P("atlan", "Atlan", "Atlan is the context layer for enterprise AI. Connect C...", "Agent Orchestration", "#4b3ff0", "a"),
  P("aws-agents", "AWS Agents", "Build, deploy, and operate AI agents on AWS. Skills f...", "Agent Orchestration", "#232f3e", "aws", "#ff9900"),
  P("aws-sagemaker", "AWS SageMaker", "Build, train, and deploy AI models with deep AWS AI/...", "Agent Orchestration", "#232f3e", "aws", "#ff9900"),
  P("docs-canvas", "Docs Canvas", "Render documentation as a navigable canvas.", "Canvas", "#3a3a3a", "≡"),
  P("pr-canvas", "PR Review Canvas", "Render PR diffs as review canvases grouped by impo...", "Canvas", "#3a3a3a", "≡"),
  P("intercom", "Intercom", "Manage conversations and customers.", "Customer Support", "#1f8ded", "◈"),
  P("plain", "Plain", "Support inbox for product teams.", "Customer Support", "#f4f0ea", "P", "#1a1a1a"),
  P("amplitude", "Amplitude", "Product analytics and experimentation.", "Data Analytics", "#1e61f0", "a."),
  P("antimetal", "Antimetal", "Cloud cost intelligence.", "Data Analytics", "#111", "◐"),
  P("apify", "Apify", "Web scraping and automation platform.", "Data Analytics", "#57d3a6", "⬡", "#0b3b2d"),
  P("astronomer", "Astronomer", "Run Apache Airflow pipelines.", "Data Analytics", "#0b0d0f", "✦", "#fff"),
  P("mobbin", "Mobbin", "Discover real-world design patterns.", "Design", "#ff5c39", "M"),
  P("superdesign", "Superdesign", "Design agent for UI iterations.", "Design", "#111", "S"),
  P("coda", "Coda", "Docs and docs-like apps.", "Documents And Files", "#f46a54", "C"),
  P("craft", "Craft", "Create beautiful documents.", "Documents And Files", "#fff", "✎", "#f65a3c"),
  P("docusign", "Docusign", "Send and manage agreements.", "Finance And Legal", "#ffcc22", "ds", "#231f20"),
  P("brevo", "Brevo", "Email marketing and CRM.", "Inbox And Collaboration", "#0b996e", "B"),
  P("calendly", "Calendly", "Schedule meetings without the back-and-forth.", "Inbox And Collaboration", "#006bff", "C"),
  P("customerio", "Customer.io", "Send targeted messages at scale.", "Inbox And Collaboration", "#5c6bff", "c."),
  P("inkbox", "Inkbox", "Inbox management agent.", "Inbox And Collaboration", "#1f1f1f", "◻"),
  P("aws-location", "Amazon Location Service", "Add maps and location to apps.", "Infrastructure", "#232f3e", "aws", "#ff9900"),
  P("appwrite", "Appwrite", "Backend platform for web and mobile.", "Infrastructure", "#f02e65", "a"),
  P("aws-amplify", "AWS Amplify", "Build fullstack apps on AWS.", "Infrastructure", "#232f3e", "aws", "#ff9900"),
  P("aws-core", "AWS Core", "Core AWS account operations.", "Infrastructure", "#232f3e", "aws", "#ff9900"),
  P("1password", "1Password", "Retrieve secrets and manage vaults.", "MCP", "#1a1a1a", "1", "#fefefe"),
  P("agent-compat", "Agent Compatibility", "Check agent tool compatibility.", "MCP", "#2d5df6", "⚙"),
  P("aikido", "Aikido", "Code security platform.", "MCP", "#111", "◈", "#e0e0e0"),
  P("aleph", "Aleph", "Data search agent.", "MCP", "#6c47ff", "α"),
  P("1inch", "1inch", "DeFi swaps and quotes.", "Payments", "#e84a8b", "1"),
  P("airwallex-agentos", "Airwallex AgentOS", "Payments operations for agents.", "Payments", "#ff4f00", "a"),
  P("airwallex-dev", "Airwallex Developer", "Airwallex developer docs and API.", "Payments", "#0b0b0b", "a", "#fff"),
  P("brex", "Brex", "Spend management and cards.", "Payments", "#f4f2ee", "b", "#f04e23"),
  P("adobe-dev", "Adobe Developer App Builder", "Build apps on Adobe APIs.", "Productivity", "#eb1000", "A"),
  P("agentmail", "AgentMail", "Inboxes for AI agents.", "Productivity", "#111", "@"),
  P("airtable", "Airtable", "Query, create, and update records.", "Productivity", "#fff", "◤", "#fcb400"),
  P("asana", "Asana", "Manage tasks and projects.", "Productivity", "#fff", "◍", "#f06a6a"),
  P("ahrefs", "Ahrefs", "SEO data and site audits.", "Research", "#f60", "a"),
  P("context-dev", "Context.dev", "Search technical docs.", "Research", "#111", "c."),
  P("treg", "Treg", "Research assistant.", "Research", "#3f8cff", "t"),
  P("amplemarket", "Amplemarket", "Sales engagement data.", "Sales", "#4353ff", "a"),
  P("clay", "Clay", "GTM data and enrichment.", "Sales", "#fff", "◍", "#7ee2b8"),
  P("gong", "Gong", "Revenue intelligence calls.", "Sales", "#8039df", "g"),
  P("hubspot", "HubSpot", "CRM contacts, deals, companies.", "Sales", "#ff5c35", "h"),
  P("zoom", "Zoom", "Meetings and scheduling.", "Scheduling", "#2d8cff", "▣"),
];
const CATEGORIES = ["All", "Featured", "Agent Orchestration", "Canvas", "Customer Support", "Data Analytics", "Design", "Documents And Files", "Finance And Legal", "Inbox And Collaboration", "Infrastructure", "MCP", "Payments", "Productivity", "Research", "Sales", "Scheduling"];

/* ---------- state ---------- */
const LS_KEY = "grok-bot-recreation-v1";
let state = null;

function seedState() {
  const now = new Date();
  const t = (mins) => new Date(now.getTime() - mins * 60000);
  const chiefId = uid();
  return {
    v: 1,
    user: { name: "Gustavo Miranda", initials: "GM" },
    bots: [
      {
        id: chiefId,
        kind: "bot",
        name: "Chief of Staff",
        label: "",
        desc: "Manages your other Bots and pulls you in for decisions",
        avatar: "chief",
        messages: [
          { id: uid(), type: "text", from: "bot", text: "Hey Gustavo. Just me on the roster so far, so I’m checking what you’ve already got set up.", time: t(16).getTime() },
          {
            id: uid(), type: "prompt", style: "freetext", question: "Where should I start?",
            placeholder: "I'll tell you what I need",
            options: [{ badge: "C", label: "I'll tell you what I need" }],
            answered: 0, answerText: "I'll tell you what I need", time: t(15.5).getTime(),
          },
          { id: uid(), type: "text", from: "bot", text: "Alright, what do you need?", time: t(10).getTime() },
        ],
        unread: false, notifications: true, active: true,
      },
    ],
    activeBotId: chiefId,
    plugins: { "google-calendar": true },
    settings: { ...DEFAULT_SETTINGS },
    lastActive: { [chiefId]: Date.now() },
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.v === 1) {
        s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
        return s;
      }
    }
  } catch (e) { /* corrupted -> reseed */ }
  return seedState();
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {} }, 150);
}

const activeBot = () => state.bots.find((b) => b.id === state.activeBotId) || null;

/* ---------- generic reply scripts ---------- */
let replyIdx = 0;
const CHIEF_REPLIES = [
  "On it. I’ll line up the pieces and pull you in if anything needs a decision.",
  "Let me take that on. I’ll check what’s already set up first so we don’t duplicate work.",
  "Got it. I’ll get moving on that and report back once there’s something to see.",
];
const GENERIC_REPLIES = [
  "Got it — I’ll take that on and report back.",
  "On it. I’ll set that up and let you know how it goes.",
  "Understood. I’ll prioritize that today.",
];

function botRespond(bot, userText) {
  const lower = (userText || "").toLowerCase();
  const seq = [];
  if (bot.avatar === "chief" && /(calendar|schedule|week|plan)/.test(lower)) {
    if (state.plugins["google-calendar"]) {
      seq.push({ type: "text", text: "You’re all set — Google Calendar is already connected. I’ll pull your schedule for next week shortly." });
    } else {
      seq.push({ type: "text", text: "On it. First I need your calendar connected so I can see what’s already there." });
      seq.push({
        type: "prompt", style: "options", question: "Add Google Calendar so I can set up next week?",
        options: [{ badge: "A", label: "Add it" }, { badge: "B", label: "Not that calendar" }], answered: null,
        onAnswer: {
          0: [{ type: "text", text: "Adding Google Calendar now." }, { type: "text", text: "Added. Authorize it on the card that just came up and I’ll pull next week.", after: 1400, plugin: "google-calendar" }],
          1: [{ type: "text", text: "No problem. I’ll leave the calendar out and we can circle back later." }],
        },
      });
    }
  } else {
    const pool = bot.avatar === "chief" ? CHIEF_REPLIES : GENERIC_REPLIES;
    seq.push({ type: "text", text: pool[replyIdx++ % pool.length] });
  }
  playSequence(bot, seq);
}

/* plays a list of bot messages with working indicators */
let pendingTimers = [];
function clearTimers() { pendingTimers.forEach(clearTimeout); pendingTimers = []; }
function playSequence(bot, seq, delay = 0) {
  let acc = delay;
  let first = true;
  for (const item of seq) {
    const think = first ? 900 + Math.random() * 700 : 500 + Math.random() * 600;
    acc += think;
    const at = acc;
    pendingTimers.push(setTimeout(() => {
      if (first) { bot.working = true; render(); }
      first = false;
    }, Math.max(0, at - think)));
    pendingTimers.push(setTimeout(() => {
      if (item.plugin) state.plugins[item.plugin] = true;
      const msg = { id: uid(), type: item.type === "prompt" ? "prompt" : "text", from: "bot", time: Date.now() };
      if (item.type === "prompt") { Object.assign(msg, item); delete msg.after; delete msg.plugin; }
      else msg.text = item.text;
      bot.working = false;
      bot.messages.push(msg);
      touchBot(bot);
      if (state.activeBotId !== bot.id) bot.unread = true;
      render();
    }, at));
  }
}

function touchBot(bot) {
  state.lastActive[bot.id] = Date.now();
  bot.active = true;
  for (const b of state.bots) b.active = b.id === bot.id ? true : !!b.active && Date.now() - (state.lastActive[b.id] || 0) < 5 * 60000;
  save();
}

/* ---------- rendering: avatars ---------- */
function avatarHTML(bot, size, withStatus = false) {
  let inner;
  if (bot.kind === "channel") inner = AVATARS.channel();
  else if (bot.avatar && typeof bot.avatar === "object") {
    inner = bot.avatar.image
      ? `<img class="avatar-photo" src="${bot.avatar.image}" alt="">`
      : shapeAvatarSVG(bot.avatar.shape, bot.avatar.color);
  } else inner = (AVATARS[bot.avatar] || AVATARS.newbot)();
  return `<span class="avatar-wrap"><span class="avatar avatar-${size}">${inner}</span>${withStatus && bot.active ? '<span class="status-dot"></span>' : ""}</span>`;
}

/* ---------- rendering: sidebar ---------- */
function sortedBots() {
  return [...state.bots].sort((a, b) => (state.lastActive[b.id] || 0) - (state.lastActive[a.id] || 0));
}
function lastActivity(b) {
  const m = b.messages[b.messages.length - 1];
  return m ? m.time : 0;
}
function previewText(b) {
  for (let i = b.messages.length - 1; i >= 0; i--) {
    const m = b.messages[i];
    if (m.type === "text") return m.text;
    if (m.type === "prompt") {
      const opts = m.answered != null && m.answerText ? m.answerText : m.options.map((o) => o.label).join(" / ");
      return `${m.question} — ${opts}`;
    }
    if (m.type === "system") return m.text;
  }
  return "No messages yet";
}
function renderSidebar() {
  const list = $("#botList");
  const bots = sortedBots();
  let html = "";
  if (state.draft) {
    html += `<button class="bot-item selected draft-chip" data-draft="1">${avatarHTML({ kind: state.draft.type === "channel" ? "channel" : "bot", avatar: "newbot" }, 28)}<span class="bot-item-text"><span class="bot-item-top"><span class="bot-item-name">Create new</span></span></span></button>`;
  }
  for (const b of bots) {
    const sel = !state.draft && b.id === state.activeBotId;
    html += `<button class="bot-item ${sel ? "selected" : ""}" data-id="${b.id}">
      ${avatarHTML(b, 28, true)}
      <span class="bot-item-text">
        <span class="bot-item-top"><span class="bot-item-name">${esc(b.name)}</span><span class="bot-item-time">${fmtTime(new Date(lastActivity(b) || Date.now()))}</span></span>
        <span class="bot-item-preview">${esc(previewText(b))}</span>
      </span>
      ${b.unread ? '<span class="unread-dot" title="Unread activity"></span>' : ""}
    </button>`;
  }
  list.innerHTML = html;
  $$(".bot-item", list).forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.draft) return;
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) openBot(b);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (!b) return;
      openPopover(e.clientX, e.clientY, [
        { label: "Mark as unread", icon: ICONS.dot, fn: () => { b.unread = true; save(); render(); } },
        { label: "Delete Bot", icon: ICONS.trash, danger: true, fn: () => deleteBot(b) },
      ]);
    });
  });
}

/* ---------- rendering: transcript ---------- */
function renderTranscript() {
  const bot = activeBot();
  const inner = $("#transcriptInner");
  if (state.draft || !bot) { inner.innerHTML = ""; return; }
  const frag = [];
  let lastDay = null;
  let prevFrom = null;
  let shownNew = false;
  for (const m of bot.messages) {
    const d = new Date(m.time);
    if (!lastDay || !sameDay(lastDay, d)) {
      frag.push(`<div class="time-divider">${dayLabel(d)} ${fmtTime(d)}</div>`);
      lastDay = d; prevFrom = null;
    }
    if (m.type === "system") { frag.push(`<div class="time-divider" style="margin:10px 0">${esc(m.text)}</div>`); continue; }
    if (bot.newMarkerId === m.id && !shownNew) {
      frag.push(`<div class="new-divider"><span>NEW</span></div>`);
      shownNew = true;
    }
    if (m.type === "text" && m.from === "user") {
      frag.push(userMsgHTML(m, bot));
      prevFrom = "user";
      continue;
    }
    if (m.type === "prompt") {
      frag.push(promptHTML(m, bot));
      prevFrom = "bot";
      continue;
    }
    frag.push(botTextHTML(m, bot, prevFrom === "bot"));
    prevFrom = "bot";
  }
  if (bot.working) frag.push(`<div class="working-row"><span class="working-avatar">${avatarHTML(bot, 28)}</span></div>`);
  inner.innerHTML = frag.join("");
  wireMessageEvents(bot);
}

function hoverToolsHTML(m, bot) {
  return `<span class="hover-tools">
    <span class="hover-time" title="${fmtSecs(new Date(m.time))}">${fmtTime(new Date(m.time))}</span>
    <button class="tool-btn" data-act="react" title="Add reaction"><svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.8 9.4a2.9 2.9 0 0 0 4.4 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="6.6" r="0.9" fill="currentColor"/><circle cx="10" cy="6.6" r="0.9" fill="currentColor"/></svg></button>
    <button class="tool-btn" data-act="reply" title="Reply to ${esc(bot.name)} message"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 4L3 7.5 6.5 11M3.4 7.5h5.6a3.6 3.6 0 0 1 3.6 3.6v1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button class="tool-btn" data-act="more" title="More message actions"><svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.4" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.6" cy="8" r="1.15" fill="currentColor"/></svg></button>
  </span>`;
}
function reactionsHTML(m) {
  if (!m.reactions || !m.reactions.length) return "";
  return `<span class="reactions">${m.reactions.map((r) => `<button class="reaction-chip ${r.mine ? "mine" : ""}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)}<span>${r.count}</span></button>`).join("")}</span>`;
}
function botTextHTML(m, bot, grouped) {
  return `<div class="msg-row ${grouped ? "" : "group-start"}" data-mid="${m.id}">
    <span class="msg-row-hover-target"><span class="bubble">${esc(m.text)}</span>${hoverToolsHTML(m, bot)}</span>
    ${reactionsHTML(m)}
  </div>`;
}
function userMsgHTML(m, bot) {
  return `<div class="msg-row msg-user" data-mid="${m.id}">
    <span class="msg-row-hover-target"><span class="bubble">${esc(m.text)}</span>${hoverToolsHTML(m, bot)}</span>
    ${reactionsHTML(m)}
  </div>`;
}
function promptHTML(m, bot) {
  const answered = m.answered != null;
  let body;
  if (answered) {
    const opt = m.options[m.answered] || {};
    body = `<div class="prompt-answered">
      ${m.style === "freetext" ? '<span class="option-badge round">C</span>' : `<span class="option-badge">${esc(opt.badge || "A")}</span>`}
      <span class="answer-text">${esc(m.answerText || opt.label)}</span>
      <span class="check"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </div>`;
  } else if (m.style === "freetext") {
    body = `<div class="prompt-inputrow">
      <span class="option-badge round">C</span>
      <input type="text" class="prompt-free" placeholder="${esc(m.placeholder || "Type your answer")}" aria-label="Your answer">
      <button class="prompt-submit" title="Submit answer"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>`;
  } else {
    body = `<div class="prompt-options">${m.options.map((o, i) => `
      <button class="prompt-option" data-idx="${i}"><span class="option-badge">${esc(o.badge)}</span><span>${esc(o.label)}</span></button>`).join("")}
    </div>`;
  }
  const dismiss = answered ? "" : `<button class="prompt-dismiss" title="Dismiss question"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
  return `<div class="msg-row group-start" data-mid="${m.id}">
    <div class="prompt-card">
      <div class="prompt-title"><span>${esc(m.question)}</span>${dismiss}</div>
      ${body}
    </div>
  </div>`;
}

function wireMessageEvents(bot) {
  $$(".msg-row", $("#transcriptInner")).forEach((row) => {
    const mid = row.dataset.mid;
    const m = bot.messages.find((x) => x.id === mid);
    if (!m) return;
    $$(".tool-btn", row).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        const r = btn.getBoundingClientRect();
        if (act === "react") openReactionBar(r, m, bot);
        if (act === "reply") { $("#promptInput").focus(); }
        if (act === "more") openMessageMenu(r, m, bot);
      });
    });
    $$(".prompt-option", row).forEach((optBtn) => {
      optBtn.addEventListener("click", () => answerPrompt(bot, m, parseInt(optBtn.dataset.idx, 10)));
    });
    $$(".prompt-dismiss", row).forEach((d) => {
      d.addEventListener("click", () => { m.dismissed = true; bot.messages = bot.messages.filter((x) => x.id !== m.id); save(); render(); });
    });
    const free = $(".prompt-free", row);
    if (free) {
      free.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && free.value.trim()) answerFreetext(bot, m, free.value.trim());
      });
      free.focus();
    }
    const submit = $(".prompt-submit", row);
    if (submit) submit.addEventListener("click", () => {
      if (free && free.value.trim()) answerFreetext(bot, m, free.value.trim());
    });
    $$(".reaction-chip", row).forEach((chip) => {
      chip.addEventListener("click", () => {
        const em = chip.dataset.emoji;
        const r = m.reactions.find((x) => x.emoji === em);
        if (r.mine && r.count === 1) m.reactions = m.reactions.filter((x) => x !== r);
        else { r.mine = !r.mine; r.count += r.mine ? 1 : -1; }
        save(); render();
      });
    });
  });
}
function answerPrompt(bot, m, idx) {
  m.answered = idx;
  m.answerText = m.options[idx].label;
  m.answerTime = Date.now();
  touchBot(bot); render(); save();
  const follow = m.onAnswer && m.onAnswer[idx];
  if (follow) playSequence(bot, follow.map((f) => ({ ...f })), 500);
}
function answerFreetext(bot, m, text) {
  m.answered = 0;
  m.answerText = text;
  m.answerTime = Date.now();
  touchBot(bot); render(); save();
  playSequence(bot, [{ type: "text", text: "Alright, what do you need?" }], 500);
}

/* ---------- header / composer ---------- */
function renderHeader() {
  const bot = activeBot();
  const headerLeft = $(".chat-header-left");
  const headerRight = $("#headerActions");
  if (state.draft) {
    const noun = state.draft.type === "channel" ? "Channel" : "Bot";
    const chips = state.draft.chips || [];
    headerLeft.innerHTML = `<div class="to-header"><span class="to-label">To:</span>${chips.map((c) => `<span class="to-chip">${esc(c)}<button class="x" data-chip="${esc(c)}">✕</button></span>`).join("")}<input id="toInput" placeholder="Search or create ${noun}s" value="${esc(state.draft.query || "")}"></div>`;
    headerRight.innerHTML = "";
    renderDraftDropdown();
    const inp = $("#toInput");
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.addEventListener("input", () => { state.draft.query = inp.value; renderDraftDropdown(); });
    inp.addEventListener("keydown", onDraftKey);
    $$(".to-chip .x", headerLeft).forEach((x) => x.addEventListener("click", () => {
      state.draft.chips = chips.filter((c) => c !== x.dataset.chip); renderHeader(); renderTranscript();
    }));
    return;
  }
  if (!bot) { headerLeft.innerHTML = ""; headerRight.innerHTML = ""; return; }
  headerLeft.innerHTML = `${avatarHTML(bot, 18)}<span class="chat-title">${esc(bot.name)}</span>`;
  headerRight.innerHTML = `
    <button class="icon-btn" id="btnViewDetails" title="View conversation details"><svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.8" y="3" width="12.4" height="8.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 13.8h4M8 11.6v2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`;
  $("#btnViewDetails").addEventListener("click", () => openDetails("settings"));
  $("#promptInput").placeholder = `Message ${bot.name}`;
}

/* draft (To:) dropdown */
function renderDraftDropdown() {
  closeDropdown();
  if (!state.draft) return;
  const noun = state.draft.type === "channel" ? "Channel" : "Bot";
  const q = (state.draft.query || "").toLowerCase();
  const matches = state.bots.filter((b) => b.name.toLowerCase().includes(q) && b.kind === (state.draft.type === "channel" ? "channel" : "bot"));
  const dd = document.createElement("div");
  dd.className = "nc-dropdown";
  dd.id = "ncDropdown";
  dd.innerHTML = `
    <button class="popover-item hl" data-new="1"><span class="pi-icon"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>Create new ${noun}</button>
    ${matches.map((b) => `<button class="popover-item" data-open="${b.id}">${avatarHTML(b, 22)}<span>${esc(b.name)}</span></button>`).join("")}
    <div class="nc-hints"><span><span class="kbd">Tab</span>add</span><span><span class="kbd">⏎</span>open</span></div>`;
  $("#popoverLayer").appendChild(dd);
  $("#popoverLayer").classList.add("open");
  const hr = $("#chatHeader").getBoundingClientRect();
  dd.style.left = Math.min(hr.left + 24, window.innerWidth - dd.offsetWidth - 12) + "px";
  dd.style.top = (hr.bottom + 4) + "px";
  $("[data-new]", dd).addEventListener("click", () => createFromDraft());
  $$("[data-open]", dd).forEach((el) => el.addEventListener("click", () => {
    const b = state.bots.find((x) => x.id === el.dataset.open);
    state.draft = null; render(); if (b) openBot(b);
  }));
}
function closeDropdown() { const d = $("#ncDropdown"); if (d) d.remove(); if (!$("#popoverLayer").children.length) $("#popoverLayer").classList.remove("open"); }
function onDraftKey(e) {
  if (e.key === "Escape") { e.stopPropagation(); state.draft = null; render(); }
  else if (e.key === "Enter") { e.preventDefault(); createFromDraft(); }
  else if (e.key === "Tab") {
    e.preventDefault();
    const v = $("#toInput").value.trim();
    if (v) { state.draft.chips = [...(state.draft.chips || []), v]; state.draft.query = ""; renderHeader(); renderTranscript(); }
  }
}
function createFromDraft() {
  const q = ($("#toInput") ? $("#toInput").value.trim() : "") || "";
  const name = q || (state.draft.chips && state.draft.chips.length ? state.draft.chips.join(" ") : "") || (state.draft.type === "channel" ? "New Channel" : "New Bot");
  const bot = createBot(name, state.draft.type);
  state.draft = null;
  openBot(bot);
}

/* ---------- bots ---------- */
function createBot(name, type = "bot") {
  const bot = {
    id: uid(), kind: type === "channel" ? "channel" : "bot",
    name, label: "", desc: type === "channel" ? "" : "A blank Bot with no role yet",
    avatar: type === "channel" ? "channel" : "newbot",
    messages: [], unread: false, notifications: true, active: true,
  };
  state.bots.push(bot);
  state.lastActive[bot.id] = Date.now();
  if (type !== "channel") {
    bot.working = true;
    render();
    pendingTimers.push(setTimeout(() => {
      bot.working = false;
      bot.messages.push({ id: uid(), type: "text", from: "bot", text: `Hey Gustavo, I'm here.`, time: Date.now() });
      bot.messages.push({ id: uid(), type: "text", from: "bot", text: `What do you want me on, first? Day-to-day stuff, a specific project, or something else entirely?`, time: Date.now() + 1 });
      touchBot(bot);
      if (state.activeBotId !== bot.id) bot.unread = true;
      render();
    }, 1400));
  } else {
    bot.messages.push({ id: uid(), type: "system", text: "This is the very beginning of your channel.", time: Date.now() });
  }
  save();
  return bot;
}
function deleteBot(bot) {
  state.bots = state.bots.filter((b) => b.id !== bot.id);
  delete state.lastActive[bot.id];
  if (state.activeBotId === bot.id) {
    const rest = sortedBots();
    state.activeBotId = rest.length ? rest[0].id : null;
  }
  save(); render();
}
function openBot(bot) {
  state.draft = null;
  state.activeBotId = bot.id;
  bot.unread = false;
  bot.newMarkerId = null;
  touchBot(bot);
  closeDetails();
  save(); render();
  $("#promptInput").focus();
}

/* ---------- details panel ---------- */
let detailsOpen = false;
let detailsView = "settings";
function openDetails(view) {
  detailsOpen = true; detailsView = view || detailsView;
  renderDetails();
}
function closeDetails() {
  if (avatarEditorOpen) setAvatarEditorOpen(false);
  detailsOpen = false;
  $("#detailsPanel").hidden = true;
}
function renderDetails() {
  const panel = $("#detailsPanel");
  panel.hidden = !detailsOpen;
  if (!detailsOpen) return;
  const bot = activeBot();
  const isSettings = detailsView === "settings";
  $("#detailsSettings").hidden = !isSettings;
  $("#detailsComputer").hidden = isSettings;
  $("#detailsTitle").textContent = isSettings ? "Settings" : "";
  $("#btnDetailsBack").innerHTML = isSettings
    ? `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M4 4l1.1 1.1M10.9 10.9L12 12M12 4l-1.1 1.1M5.1 10.9L4 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  $("#btnDetailsBack").title = isSettings ? "Back to details" : "Bot settings";
  if (!bot) { syncAvatarEditor(null); return; }
  $("#bigAvatar").innerHTML = avatarHTML(bot, 56);
  $("#fieldName").value = bot.name;
  $("#fieldLabel").value = bot.label || "";
  $("#fieldDesc").value = bot.desc || "";
  $("#notifToggle").classList.toggle("on", !!bot.notifications);
  $("#notifToggle").setAttribute("aria-checked", String(!!bot.notifications));
  $("#dangerZone").hidden = true;
  $("#computerCaption").textContent = `${bot.name}'s screen`;
  syncAvatarEditor(bot);
}

/* ---------- avatar editor ---------- */
let avatarEditorOpen = false;
let avatarEditorTab = "bot";
let avatarEditorRendered = ""; // tab last rendered, to preserve generate input state

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function currentAvatarCfg(bot) {
  const a = bot && typeof bot.avatar === "object" ? bot.avatar : null;
  if (a && !a.image && SHAPES[a.shape]) return { shape: a.shape, color: a.color || AVATAR_COLORS[8] };
  if (bot && bot.avatar === "chief") return { shape: "circle", color: "#e5484d" };
  return { shape: "hex", color: AVATAR_COLORS[8] };
}
function setAvatarEditorOpen(open) {
  if (avatarEditorOpen === open) return;
  avatarEditorOpen = open;
  if (open) {
    avatarEditorTab = "bot";
    document.addEventListener("click", avatarEditorOutside);
  } else {
    document.removeEventListener("click", avatarEditorOutside);
  }
  $("#btnEditAvatar").setAttribute("aria-expanded", String(open));
  renderDetails();
}
function avatarEditorOutside(e) {
  if (!avatarEditorOpen) return;
  // composedPath() stays valid even if opening the editor detached the clicked
  // node (renderDetails rebuilds the avatar), unlike target.closest().
  const hit = e.composedPath().some((n) => n.id === "avatarEditor" || n.id === "btnEditAvatar");
  if (hit) return;
  setAvatarEditorOpen(false);
}
function syncAvatarEditor(bot) {
  const ed = $("#avatarEditor");
  if (!ed) return;
  const scroll = $("#detailsSettings .settings-scroll");
  const show = avatarEditorOpen && !!bot && detailsView === "settings" && bot.kind !== "channel";
  ed.hidden = !show;
  scroll.classList.toggle("editor-open", show);
  if (!show) { avatarEditorRendered = ""; return; }
  $$(".ae-tab", ed).forEach((t) => t.classList.toggle("on", t.dataset.aeTab === avatarEditorTab));
  const btn = $("#btnEditAvatar");
  ed.style.top = Math.round(btn.offsetTop + btn.offsetHeight - 8) + "px";
  renderAvatarEditorBody(bot);
}
function renderAvatarEditorBody(bot) {
  const body = $("#aeBody");
  const key = avatarEditorTab + ":" + bot.id;
  if (avatarEditorTab === "generate" && avatarEditorRendered === key) return; // keep typed prompt
  avatarEditorRendered = key;
  if (avatarEditorTab === "bot") {
    const cfg = currentAvatarCfg(bot);
    body.innerHTML = `
      <div class="ae-shape-grid">${Object.entries(SHAPES).map(([id, s]) => `
        <button class="shape-cell ${cfg.shape === id ? "sel" : ""}" data-shape="${id}" title="${s.label}"><span class="sh">${shapeAvatarSVG(id, cfg.color)}</span></button>`).join("")}
      </div>
      <div class="ae-colors">${AVATAR_COLORS.map((c) => `
        <button class="color-dot ${cfg.color.toLowerCase() === c.toLowerCase() ? "sel" : ""}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Color ${c}"></button>`).join("")}
      </div>`;
    $$(".shape-cell", body).forEach((el) => el.addEventListener("click", () => {
      bot.avatar = { shape: el.dataset.shape, color: currentAvatarCfg(bot).color };
      save(); afterAvatarChange(bot);
    }));
    $$(".color-dot", body).forEach((el) => el.addEventListener("click", () => {
      bot.avatar = { shape: currentAvatarCfg(bot).shape, color: el.dataset.color };
      save(); afterAvatarChange(bot);
    }));
  } else if (avatarEditorTab === "generate") {
    body.innerHTML = `
      <div class="ae-gen-row">
        <input type="text" class="ae-gen-input" id="aeGenInput" placeholder="Describe this Bot, e.g. “research assistant”" aria-label="Avatar prompt">
        <button class="ae-gen-btn" id="aeGenBtn">Generate</button>
      </div>
      <div class="ae-hint">We’ll craft a unique shape and color from your prompt.</div>`;
    const run = () => {
      const p = $("#aeGenInput").value.trim() || bot.name;
      const seed = hashStr(p);
      const ids = Object.keys(SHAPES);
      bot.avatar = { shape: ids[seed % ids.length], color: AVATAR_COLORS[Math.floor(seed / 7) % AVATAR_COLORS.length] };
      save();
      avatarEditorTab = "bot";
      afterAvatarChange(bot);
      toast("Avatar generated");
    };
    $("#aeGenBtn").addEventListener("click", run);
    $("#aeGenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    $("#aeGenInput").focus();
  } else {
    body.innerHTML = `
      <button class="ae-upload" id="aeUploadBtn">
        <svg viewBox="0 0 16 16" width="20" height="20"><path d="M8 10.5V2.8M4.8 5.6L8 2.5l3.2 3.1M3 10.8v1.7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Click to upload an image</span>
      </button>
      <input type="file" id="aeFileInput" accept="image/*" hidden>`;
    $("#aeUploadBtn").addEventListener("click", () => $("#aeFileInput").click());
    $("#aeFileInput").addEventListener("change", () => {
      const f = $("#aeFileInput").files[0];
      if (!f || !f.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = () => {
        bot.avatar = { image: r.result };
        save();
        avatarEditorOpen = false;
        document.removeEventListener("click", avatarEditorOutside);
        $("#btnEditAvatar").setAttribute("aria-expanded", "false");
        renderDetails();
        toast("Avatar updated");
      };
      r.readAsDataURL(f);
    });
  }
}
function afterAvatarChange(bot) {
  renderSidebar();
  renderHeader();
  renderDetails();
}

/* ---------- popovers ---------- */
const ICONS = {
  bot: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="4.5" width="10" height="8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6.4" cy="8.2" r="1" fill="currentColor"/><circle cx="9.6" cy="8.2" r="1" fill="currentColor"/><path d="M8 4.5V2.6M8 2.4a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z" fill="currentColor"/></svg>`,
  hash: `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M6.5 2.5l-1.6 11M11.1 2.5l-1.6 11M3.2 5.8h10M2.8 10.2h10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  gauge: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 8L10.8 5.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/></svg>`,
  phone: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="4.4" y="1.6" width="7.2" height="12.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M7 12.6h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  gear: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.8l1 1.8 2-.4.5 2 2 .9-1 1.9 1 1.9-2 .9-.5 2-2-.4-1 1.8-1-1.8-2 .4-.5-2-2-.9 1-1.9-1-1.9 2-.9.5-2 2 .4z" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linejoin="round"/></svg>`,
  info: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="5" r="0.9" fill="currentColor"/></svg>`,
  help: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.4 6.2A1.7 1.7 0 1 1 8 8.4v1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.4" r="0.85" fill="currentColor"/></svg>`,
  feedback: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 6.8L12 3v10L2.5 9.2zM12 6.5a2 2 0 0 1 0 3M4.8 9.7v3.1a.9.9 0 0 0 .9.9h.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  logout: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dot: `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="2.4" fill="#4a9eff"/></svg>`,
  monitor: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1.8" y="3" width="12.4" height="8.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 13.8h4M8 11.6v2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  bars: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 13.5V8M8 13.5V2.5M13 13.5V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  refresh: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7M13.4 2.2v2.6h-2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plug: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 2.5v2a1.5 1.5 0 0 1-1.5 1.5H3v4h2a1.5 1.5 0 0 1 1.5 1.5v2h3v-2A1.5 1.5 0 0 1 11 10h2V6h-2a1.5 1.5 0 0 1-1.5-1.5v-2h-3z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 4.5h10M6.5 4.5V3.2a.9.9 0 0 1 .9-.9h1.2a.9.9 0 0 1 .9.9v1.3M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
function openPopover(x, y, items, opts = {}) {
  closePopover();
  const layer = $("#popoverLayer");
  layer.classList.add("open");
  const pop = document.createElement("div");
  pop.className = "popover";
  pop.innerHTML = (opts.title ? `<div class="popover-title">${esc(opts.title)}</div>` : "") + items.map((it, i) =>
    it === "-" ? `<div class="popover-divider"></div>` :
    `<button class="popover-item ${it.hl ? "hl" : ""}" data-i="${i}"><span class="pi-icon">${it.icon || ""}</span><span>${esc(it.label)}</span>${it.meta ? `<span class="pi-meta">${it.meta}</span>` : ""}</button>`).join("");
  layer.appendChild(pop);
  const rect = pop.getBoundingClientRect();
  let px = Math.min(x, window.innerWidth - rect.width - 10);
  let py = y;
  if (py + rect.height > window.innerHeight - 10) py = y - rect.height - (opts.gap ? opts.gap * 2 : 8);
  if (py < 6) py = 6;
  pop.style.left = px + "px";
  pop.style.top = py + "px";
  $$(".popover-item", pop).forEach((el) => {
    const it = items[parseInt(el.dataset.i, 10)];
    if (it && it.fn) el.addEventListener("click", () => { closePopover(); it.fn(); });
  });
  $("#popoverLayer").addEventListener("click", popoverOutside);
  document.addEventListener("keydown", popEsc);
}
function popoverOutside(e) { if (!e.target.closest(".popover")) closePopover(); }
function popEsc(e) { if (e.key === "Escape") closePopover(); }
function closePopover() {
  $$("#popoverLayer .popover").forEach((p) => p.remove());
  $("#popoverLayer").classList.remove("open");
  $("#popoverLayer").removeEventListener("click", popoverOutside);
  document.removeEventListener("keydown", popEsc);
}

const REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"];
function openReactionBar(rect, m, bot) {
  closePopover();
  const layer = $("#popoverLayer");
  layer.classList.add("open");
  const pop = document.createElement("div");
  pop.className = "popover reaction-bar";
  pop.innerHTML = REACTIONS.map((e) => `<button data-e="${e}">${e}</button>`).join("") +
    `<button class="more-emoji" title="More emoji"><svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>`;
  layer.appendChild(pop);
  pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + "px";
  pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + "px";
  $$("button", pop).forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.e) {
      const e = b.dataset.e;
      m.reactions = m.reactions || [];
      const r = m.reactions.find((x) => x.emoji === e);
      if (r) { if (r.mine) { r.count--; r.mine = false; if (r.count <= 0) m.reactions = m.reactions.filter((x) => x !== r); } else { r.count++; r.mine = true; } }
      else m.reactions.push({ emoji: e, count: 1, mine: true });
      save(); render();
    }
    closePopover();
  }));
  $("#popoverLayer").addEventListener("click", popoverOutside);
  document.addEventListener("keydown", popEsc);
}
function openMessageMenu(rect, m, bot) {
  openPopover(rect.left, rect.bottom + 6, [
    { label: "Copy Text", icon: "", fn: () => { navigator.clipboard && navigator.clipboard.writeText(m.text || "").catch(() => {}); toast("Copied"); } },
    { label: "Copy Message Link", icon: "", fn: () => toast("Link copied") },
    "-",
    { label: "Delete Message", icon: ICONS.trash, fn: () => { bot.messages = bot.messages.filter((x) => x.id !== m.id); save(); render(); } },
  ]);
}

/* ---------- account menu ---------- */
function openAccountMenu() {
  const r = $("#btnAccount").getBoundingClientRect();
  openPopover(r.left + 4, r.top - 8, [
    { label: "Settings", icon: ICONS.gear },
    { label: "About", icon: ICONS.info },
    { label: "Help Center", icon: ICONS.help },
    { label: "Send Feedback", icon: ICONS.feedback },
    "-",
    { label: "Log out", icon: ICONS.logout },
  ], { gap: 10 });
  $$(".popover .popover-item").forEach((el) => {
    const label = el.textContent.trim();
    el.addEventListener("click", () => {
      if (label === "Settings") { closePopover(); openSettings(); }
      else if (label === "About") toast("Grok Bot — a faithful recreation");
      else if (label === "Log out") toast("Logged out (demo)");
      else toast(label);
    });
  });
}

/* ---------- new menu ---------- */
function openNewMenu() {
  const r = $("#btnNewMenu").getBoundingClientRect();
  openPopover(r.left, r.bottom + 8, [
    { label: "New Bot", icon: ICONS.bot, fn: () => { state.draft = { type: "bot", query: "", chips: [] }; render(); } },
    { label: "New Channel", icon: ICONS.hash, fn: () => { state.draft = { type: "channel", query: "", chips: [] }; render(); } },
  ]);
}

/* ---------- plugins modal ---------- */
let pluginCat = "All";
function renderPlugins() {
  const q = $("#pluginSearchInput").value.trim().toLowerCase();
  const chips = $("#pluginChips");
  chips.innerHTML = CATEGORIES.map((c) => `<button class="chip ${c === pluginCat ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
  $$(".chip", chips).forEach((ch) => ch.addEventListener("click", () => { pluginCat = ch.dataset.cat; renderPlugins(); }));
  const list = $("#pluginList");
  let items = PLUGINS.filter((p) => (pluginCat === "All" || p.cat === pluginCat) && (!q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)));
  const byCat = new Map();
  for (const p of items) { if (!byCat.has(p.cat)) byCat.set(p.cat, []); byCat.get(p.cat).push(p); }
  const installedCount = Object.values(state.plugins).filter(Boolean).length;
  $("#installedCount").textContent = `${installedCount} installed`;
  let html = "";
  for (const [cat, ps] of byCat) {
    if (pluginCat === "All" && q) { /* filtered: flat list */ }
    html += `<div class="plugin-section-head"><span class="plugin-section-name">${esc(cat)}</span>${ps.length >= 3 && cat !== "Research" ? `<button class="view-all">View all</button>` : ""}</div>`;
    html += `<div class="plugin-grid">${ps.map((p) => pluginCardHTML(p)).join("")}</div>`;
  }
  if (!items.length) html = `<div class="time-divider" style="margin-top:40px">No plugins found</div>`;
  list.innerHTML = html;
  $$(".plugin-add", list).forEach((btn) => btn.addEventListener("click", () => {
    const id = btn.dataset.id;
    if (state.plugins[id]) delete state.plugins[id];
    else state.plugins[id] = true;
    save(); renderPlugins();
  }));
}
function pluginCardHTML(p) {
  const added = !!state.plugins[p.id];
  return `<div class="plugin-card">
    <span class="plugin-ic" style="background:${p.bg};color:${p.fg}">${esc(p.glyph)}</span>
    <span class="plugin-meta"><span class="plugin-name">${esc(p.name)}</span><span class="plugin-desc">${esc(p.desc)}</span></span>
    <button class="plugin-add ${added ? "added" : ""}" data-id="${p.id}">${added ? "✓ Added" : "Add"}</button>
  </div>`;
}
function openPlugins() { $("#pluginsOverlay").hidden = false; renderPlugins(); $("#pluginSearchInput").focus(); }
function closePlugins() { $("#pluginsOverlay").hidden = true; }

/* ---------- settings window (mirrors the original app) ---------- */
const DEFAULT_SETTINGS = {
  theme: "Follow System", language: "Follow System",
  microphone: "System Default", hwAccel: true,
  timezone: "Auto-detect (America/Fortaleza)",
  autoReview: true, rules: [], ruleBehavior: "Allow automatically",
  securityKeys: true,
  computerLabel: "Gustavos-MacBook-Air.local", execution: "Ask every time",
  updateTrack: "Stable",
};
let settingsSection = "general";
let settingsDraft = null; // in-modal editable copy

const SETTING_SECTIONS = [
  { id: "general", label: "General", icon: "gear" },
  { id: "computer", label: "Computer", icon: "monitor" },
  { id: "usage", label: "Usage & Billing", icon: "bars" },
  { id: "updates", label: "Updates", icon: "refresh" },
];

function openSettings(section) {
  if (!state.settings) state.settings = { ...DEFAULT_SETTINGS };
  settingsDraft = JSON.parse(JSON.stringify(state.settings));
  if (section) settingsSection = section;
  $("#settingsOverlay").hidden = false;
  renderSettings();
}
function closeSettings() { $("#settingsOverlay").hidden = true; settingsDraft = null; }
function commitSettings() { state.settings = JSON.parse(JSON.stringify(settingsDraft)); save(); }
function renderSettings() {
  const nav = $("#settingsNav");
  nav.innerHTML = SETTING_SECTIONS.map((s) => `
    <button class="settings-nav-item ${s.id === settingsSection ? "on" : ""}" data-s="${s.id}">
      <span class="pi-icon">${s.icon === "gear" ? ICONS.gear : s.icon === "monitor" ? ICONS.monitor : s.icon === "bars" ? ICONS.bars : ICONS.refresh}</span>
      <span>${esc(s.label)}</span>
    </button>`).join("");
  $$(".settings-nav-item", nav).forEach((el) => el.addEventListener("click", () => { settingsSection = el.dataset.s; renderSettings(); }));
  const c = $("#settingsContent");
  const sec = SETTING_SECTIONS.find((s) => s.id === settingsSection);
  c.innerHTML = `<div class="settings-head">${esc(sec.label)}</div><div class="settings-scroll-area">${settingsBodyHTML()}</div>`;
  wireSettings();
}
function rowHTML(title, desc, control, opts = {}) {
  const t = opts.html ? title : (typeof title === "string" ? `<div class="settings-row-title">${esc(title)}</div>` : title);
  return `<div class="settings-row" data-copy="${esc(opts.link || title || "")}">
    <div class="settings-row-top">${t}${desc ? `<div class="settings-row-desc">${esc(desc)}</div>` : ""}${opts.below || ""}</div>
    ${control || ""}
    <button class="copy-link-btn" title="Copy link to this setting"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M6.5 9.5l3-3M5 7L3.6 8.4a2.4 2.4 0 0 0 3.4 3.4L8.4 10.4M8 5.6l1.4-1.4a2.4 2.4 0 0 1 3.4 3.4L11.4 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>
  </div>`;
}
function selectHTML(id, value) {
  return `<button class="settings-select" data-dd="${id}"><span>${esc(value)}</span><span class="chev"><svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>`;
}
function toggleHTML(id, on) {
  return `<button class="settings-toggle ${on ? "on" : ""}" data-tg="${id}" role="switch" aria-checked="${!!on}"><span class="knob"></span></button>`;
}
function settingsBodyHTML() {
  const s = settingsDraft;
  if (settingsSection === "general") {
    return `
      <div class="settings-group-label">Account</div>
      <div class="settings-card"><div class="acct-row">
        <span class="acct-avatar">GM</span>
        <span style="flex:1"><span class="acct-name">Gustavo Miranda</span>
          <span class="acct-email-row"><span class="acct-email">gustmrg@gmail.com</span>
          <button class="acct-copy" id="btnCopyEmail" title="Copy email address"><svg viewBox="0 0 16 16" width="13" height="13"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button></span>
        </span>
        <button class="settings-btn" id="btnSignOut">Sign Out</button>
      </div></div>

      <div class="settings-group-label">Appearance</div>
      <div class="settings-card">
        ${rowHTML("Theme", "", selectHTML("theme", s.theme), { link: "Theme" })}
        ${rowHTML("Language", "", selectHTML("language", s.language), { link: "Language" })}
      </div>

      <div class="settings-group-label">System</div>
      <div class="settings-card">
        ${rowHTML("Microphone", "", selectHTML("microphone", s.microphone), { link: "Microphone" })}
        ${rowHTML("Use hardware acceleration", "", toggleHTML("hwAccel", s.hwAccel), { link: "Use hardware acceleration" })}
      </div>

      <div class="settings-group-label">Bot</div>
      <div class="settings-card">
        ${rowHTML("Timezone", "", selectHTML("timezone", s.timezone), { link: "Timezone" })}
        ${rowHTML("Auto-review", "Grok Bot checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically.", toggleHTML("autoReview", s.autoReview), { link: "Auto-review" })}
        <div class="settings-row" style="display:block">
          <div class="settings-row-title">Auto-review Rules</div>
          <div class="settings-row-desc">Write one short, natural-language rule for each action. "Ask first" takes priority if rules conflict.</div>
          ${s.rules.length ? `<div class="settings-card" style="margin:10px 0 0">${s.rules.map((r, i) => `
            <div class="settings-row rule-row" style="padding:10px 16px"><span class="rule-text">${esc(r.when)} → ${esc(r.behavior)}</span><button class="rule-del" data-del="${i}"><svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></div>`).join("")}</div>` : ""}
          <div class="settings-row-desc" style="margin-top:12px">When Grok Bot wants to:</div>
          <input class="settings-input" id="ruleWhen" style="width:100%;margin-top:5px" placeholder="e.g. reply to emails for me">
          <div class="settings-row-desc" style="margin-top:10px">It should:</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:5px">
            ${selectHTML("ruleBehavior", s.ruleBehavior)}
            <span style="flex:1"></span>
            <button class="settings-btn" id="btnAddRule" disabled>Add Rule</button>
          </div>
          <div class="settings-row-desc" style="margin-top:12px">These rules apply only to you. Built-in safety checks always apply.</div>
        </div>
      </div>

      <div class="settings-group-label">Security Key</div>
      <div class="settings-card">
        ${rowHTML("Use hardware security keys", "Allow Grok Bot to use a security key (such as a YubiKey) connected to your computer. You'll be asked to approve each use.", toggleHTML("securityKeys", s.securityKeys), { link: "Use hardware security keys" })}
      </div>`;
  }
  if (settingsSection === "computer") {
    return `
      <div class="settings-group-label">Computers</div>
      <div class="settings-card">
        ${rowHTML("Current computer", "This is the computer you are using now", `
          <input class="settings-input" id="compLabel" value="${esc(s.computerLabel)}">
          <button class="settings-btn" id="btnSaveComp" disabled>Save</button>`, { link: "Current computer" })}
        ${rowHTML("Execution on this computer", "Let Grok Bot open files and run tasks on your computer. Auto-review still checks everything first.", selectHTML("execution", s.execution), { link: "Execution on this computer" })}
      </div>`;
  }
  if (settingsSection === "usage") {
    return `
      <div class="settings-group-label">Usage</div>
      <div class="settings-card"><div class="settings-row" style="display:block">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span class="settings-row-title">Trial usage</span><span class="settings-row-title" style="font-weight:500">6%</span>
        </div>
        <div class="trial-track"><div class="trial-fill" style="width:6.15%"></div></div>
        <div class="trial-meta">Ends in 7 days</div>
      </div></div>

      <div class="settings-group-label">Manage Plan</div>
      <div class="settings-card">
        ${rowHTML("Upgrade to Pro", "Get more Grok Bot usage", `<button class="settings-btn light" id="btnUpgrade">Upgrade to Pro</button>`, { link: "Upgrade to Pro" })}
        ${rowHTML("Get Access with Grok", "Link SuperGrok, SuperGrok Plus, SuperGrok Heavy, or X Premium+ for Grok Bot access with a separate usage pool", `<button class="settings-btn light" id="btnGetAccess">Get Access with Grok</button>`, { link: "Get Access with Grok" })}
        ${rowHTML("Cancel Trial", "", `<button class="settings-btn plain" id="btnCancelTrial">Cancel Trial</button>`, { link: "Cancel Trial" })}
      </div>`;
  }
  return `
    <div class="settings-group-label">Grok Bot Updates</div>
    <div class="settings-card">
      ${rowHTML("Update Track", "Stable is the safe default. Other tracks ship new builds earlier and more often. Switching checks for updates right away.", selectHTML("updateTrack", s.updateTrack), { link: "Update Track" })}
      ${rowHTML(`<div class="settings-row-title">Version <span class="ver">0.30.0</span></div>`, "Updates follow the Stable track\nYou're up to date", `<button class="settings-btn light" id="btnCheckUpdates">Check for Updates</button>`, { link: "Version", html: true })}
    </div>

    <div class="settings-group-label">Grok Bot's Computer</div>
    <div class="settings-card">
      <div class="settings-row" style="display:block">
        <div class="settings-row-top">
          <div class="settings-row-title">Update Grok Bot's Computer</div>
          <div class="settings-row-desc">Updates the computer your assistants share. Your files and logins stay, but installed apps and packages are removed. All assistants update together.</div>
          <div class="info-banner"><svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="#7fb3ff" stroke-width="1.3"/><path d="M8 7.4v3.4" stroke="#7fb3ff" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="5" r="0.9" fill="#7fb3ff"/></svg>Your computer is on the latest version</div>
        </div>
      </div>
      ${rowHTML("Reset Grok Bot's Computer", "Start fresh if the computer gets stuck. It's rebuilt from your last saved snapshot, so very recent changes may be lost.", `<button class="settings-btn red" id="btnResetComp">Reset</button>`, { link: "Reset Grok Bot's Computer" })}
    </div>`;
}
const DD_OPTIONS = {
  theme: ["Follow System", "Light", "Dark"],
  language: ["Follow System", "English"],
  microphone: ["System Default", "MacBook Pro Microphone", "AirPods Pro Microphone"],
  timezone: ["Auto-detect (America/Fortaleza)", "Auto-detect (America/New_York)", "Auto-detect (Europe/Berlin)", "UTC"],
  ruleBehavior: ["Allow automatically", "Ask first", "Block"],
  execution: ["Ask every time", "Allow automatically", "Never run"],
  updateTrack: ["Stable", "Beta", "Nightly"],
};
function wireSettings() {
  const c = $("#settingsContent");
  // dropdowns
  $$(".settings-select", c).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.dd;
      const r = btn.getBoundingClientRect();
      openPopover(r.left, r.bottom + 6, DD_OPTIONS[key].map((opt) => ({
        label: opt, hl: opt === settingsDraft[key],
        fn: () => { settingsDraft[key] = opt; commitSettings(); renderSettings(); },
      })));
    });
  });
  // toggles
  $$(".settings-toggle", c).forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.tg;
      settingsDraft[key] = !settingsDraft[key];
      commitSettings(); renderSettings();
    });
  });
  // copy link buttons
  $$(".copy-link-btn", c).forEach((btn) => btn.addEventListener("click", () => toast("Link copied")));
  // account
  const copyEmail = $("#btnCopyEmail");
  if (copyEmail) copyEmail.addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText("gustmrg@gmail.com").catch(() => {}); toast("Email copied"); });
  const signOut = $("#btnSignOut");
  if (signOut) signOut.addEventListener("click", () => toast("Signed out (demo)"));
  // auto-review rules
  const ruleWhen = $("#ruleWhen");
  const addBtn = $("#btnAddRule");
  if (ruleWhen && addBtn) {
    ruleWhen.addEventListener("input", () => { addBtn.disabled = !ruleWhen.value.trim(); });
    ruleWhen.addEventListener("keydown", (e) => { if (e.key === "Enter" && ruleWhen.value.trim()) addRule(); });
    addBtn.addEventListener("click", addRule);
    function addRule() {
      settingsDraft.rules.push({ when: ruleWhen.value.trim(), behavior: settingsDraft.ruleBehavior });
      commitSettings(); renderSettings();
    }
  }
  $$(".rule-del", c).forEach((btn) => btn.addEventListener("click", () => {
    settingsDraft.rules.splice(parseInt(btn.dataset.del, 10), 1);
    commitSettings(); renderSettings();
  }));
  // computer
  const compLabel = $("#compLabel");
  const saveBtn = $("#btnSaveComp");
  if (compLabel && saveBtn) {
    compLabel.addEventListener("input", () => { saveBtn.disabled = compLabel.value === settingsDraft.computerLabel; });
    saveBtn.addEventListener("click", () => { settingsDraft.computerLabel = compLabel.value; commitSettings(); toast("Saved"); renderSettings(); });
  }
  // usage buttons
  const map = { btnUpgrade: "Opening plans…", btnGetAccess: "Opening Grok access…", btnCancelTrial: "Trial cancelled (demo)", btnCheckUpdates: "You're up to date", btnResetComp: "Computer reset scheduled" };
  Object.entries(map).forEach(([id, msg]) => {
    const el = $("#" + id);
    if (el) el.addEventListener("click", () => toast(msg));
  });
}

/* ---------- search modal ---------- */
let searchTab = "All";
const SEARCH_TABS = ["All", "Messages", "Bots", "Channels", "Files", "Links", "Routines", "Actions"];
function searchResults() {
  const q = $("#searchInput").value.trim().toLowerCase();
  const out = [];
  if (searchTab === "All" || searchTab === "Bots" || searchTab === "Channels") {
    for (const b of sortedBots()) {
      if (b.kind === "channel" && searchTab !== "All" && searchTab !== "Channels") continue;
      if (b.kind === "bot" && searchTab === "Channels") continue;
      if (q && !b.name.toLowerCase().includes(q)) continue;
      out.push({ kind: "bot", bot: b });
    }
  }
  if (searchTab === "All" || searchTab === "Actions") {
    const acts = [
      { title: "Chat Settings", sub: "Current chat", icon: "gear", fn: () => openDetails("settings") },
      { title: "Settings: General", sub: "Settings", icon: "gear", fn: () => openSettings("general") },
      { title: "Settings: Computer", sub: "Settings", icon: "monitor", fn: () => openSettings("computer") },
      { title: "Settings: Usage & Billing", sub: "Settings", icon: "gauge", fn: () => openSettings("usage") },
      { title: "Settings: Updates", sub: "Settings", icon: "gear", fn: () => openSettings("updates") },
      { title: "Plugins", sub: "", icon: "plug", fn: openPlugins },
      { title: "Theme: System", sub: "Settings · Appearance", icon: "gear", current: true, fn: () => { settingsDraft = JSON.parse(JSON.stringify(state.settings)); settingsDraft.theme = "Follow System"; commitSettings(); toast("Theme: System"); } },
      { title: "Theme: Light", sub: "Settings · Appearance", icon: "gear", fn: () => { settingsDraft = JSON.parse(JSON.stringify(state.settings)); settingsDraft.theme = "Light"; commitSettings(); toast("Theme: Light"); } },
      { title: "Theme: Dark", sub: "Settings · Appearance", icon: "gear", fn: () => { settingsDraft = JSON.parse(JSON.stringify(state.settings)); settingsDraft.theme = "Dark"; commitSettings(); toast("Theme: Dark"); } },
      { title: "Check for Updates", sub: "Updates", icon: "info", fn: () => openSettings("updates") },
    ];
    for (const a of acts) if (!q || a.title.toLowerCase().includes(q)) out.push({ kind: "action", action: a });
  }
  return out;
}
function renderSearch() {
  const tabs = $("#searchTabs");
  tabs.innerHTML = SEARCH_TABS.map((t) => `<button class="search-tab ${t === searchTab ? "on" : ""}">${t}</button>`).join("");
  $$(".search-tab", tabs).forEach((t) => t.addEventListener("click", () => { searchTab = t.textContent; renderSearch(); }));
  const res = searchResults();
  const list = $("#searchResults");
  list.innerHTML = res.map((r, i) => {
    if (r.kind === "bot") {
      const b = r.bot;
      return `<button class="search-result ${i === 0 ? "hl" : ""}" data-i="${i}">
        ${avatarHTML(b, 24, true)}
        <span class="sr-text"><span class="sr-title">${esc(b.name)}</span><span class="sr-sub">${esc(b.desc || b.name)}</span></span>
        <span class="sr-meta">${b.unread ? '<span class="mini-dot"></span>' : ""}${b.kind === "channel" ? "Channel" : "Bot"}</span>
      </button>`;
    }
    const a = r.action;
    const aIcon = ICONS[a.icon] || ICONS.gear;
    return `<button class="search-result" data-i="${i}">
      <span class="avatar avatar-24" style="border-radius:7px;color:#8f8f8f">${aIcon}</span>
      <span class="sr-text"><span class="sr-title">${esc(a.title)}${a.current ? ' <span class="sr-sub-inline">· Current</span>' : ""}</span>${a.sub ? `<span class="sr-sub">${esc(a.sub)}</span>` : ""}</span>
      <span class="sr-meta">Action</span>
    </button>`;
  }).join("") || `<div class="time-divider" style="margin-top:30px">No results</div>`;
  $$(".search-result", list).forEach((el) => el.addEventListener("click", () => {
    const r = res[parseInt(el.dataset.i, 10)];
    closeSearch();
    if (r.kind === "bot") openBot(r.bot); else r.action.fn();
  }));
}
function openSearch() { $("#searchOverlay").hidden = false; $("#searchInput").value = ""; renderSearch(); $("#searchInput").focus(); }
function closeSearch() { $("#searchOverlay").hidden = true; }

/* ---------- toast ---------- */
function toast(msg) {
  $$(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

/* ---------- composer ---------- */
function sendMessage() {
  const inp = $("#promptInput");
  const text = inp.value.trim();
  if (!text) return;
  const bot = activeBot();
  if (!bot || state.draft) { inp.value = ""; return; }
  inp.value = "";
  autoGrow(inp);
  bot.messages.push({ id: uid(), type: "text", from: "user", text, time: Date.now() });
  touchBot(bot);
  render();
  botRespond(bot, text);
}
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

/* ---------- wiring ---------- */
function wire() {
  $("#btnToggleCompact").addEventListener("click", () => $("#sidebar").classList.toggle("compact"));
  $("#btnToggleDetails").addEventListener("click", () => { detailsOpen ? closeDetails() : openDetails(detailsView); });
  $("#btnNewMenu").addEventListener("click", (e) => { e.stopPropagation(); openNewMenu(); });
  $("#sidebarSearchBtn").addEventListener("click", openSearch);
  $("#btnAccount").addEventListener("click", (e) => { e.stopPropagation(); openAccountMenu(); });

  $("#promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $("#promptInput").addEventListener("input", (e) => autoGrow(e.target));
  $("#btnAttach").addEventListener("click", () => toast("File attachments aren’t wired up yet"));
  $("#btnMic").addEventListener("click", () => {
    const b = $("#btnMic");
    b.classList.toggle("listening");
    if (b.classList.contains("listening")) toast("Listening… (voice input is decorative)");
    else toast("Voice input stopped");
  });

  // details panel
  $("#btnDetailsClose").addEventListener("click", closeDetails);
  $("#btnDetailsBack").addEventListener("click", () => { detailsView = detailsView === "settings" ? "computer" : "settings"; renderDetails(); });
  $("#fieldName").addEventListener("input", (e) => { const b = activeBot(); if (b) { b.name = e.target.value || "Untitled"; save(); renderSidebar(); renderHeader(); } });
  $("#fieldLabel").addEventListener("input", (e) => { const b = activeBot(); if (b) { b.label = e.target.value; save(); } });
  $("#fieldDesc").addEventListener("input", (e) => { const b = activeBot(); if (b) { b.desc = e.target.value; save(); } });
  $("#notifToggle").addEventListener("click", () => { const b = activeBot(); if (b) { b.notifications = !b.notifications; save(); renderDetails(); } });
  $("#btnShareTemplate").addEventListener("click", () => toast("Template link copied"));
  $("#btnEditAvatar").addEventListener("click", () => setAvatarEditorOpen(!avatarEditorOpen));
  $$(".ae-tab").forEach((t) => t.addEventListener("click", () => { avatarEditorTab = t.dataset.aeTab; renderDetails(); }));
  $("#btnDeleteBot").addEventListener("click", () => { const b = activeBot(); if (b) { deleteBot(b); toast("Bot deleted"); } });
  $("#btnCreateRoutine").addEventListener("click", () => toast("Routines aren’t wired up yet"));
  $("#computerPreview").addEventListener("click", () => toast("The Bot’s computer opens in the full app"));

  // plugins modal
  $("#btnPluginsClose").addEventListener("click", closePlugins);
  $("#pluginsOverlay").addEventListener("click", (e) => { if (e.target === $("#pluginsOverlay")) closePlugins(); });
  $("#pluginSearchInput").addEventListener("input", renderPlugins);
  $("#installedRow").addEventListener("click", () => { pluginCat = "All"; $("#pluginSearchInput").value = ""; renderPlugins(); });

  // search modal
  $("#searchOverlay").addEventListener("click", (e) => { if (e.target === $("#searchOverlay")) closeSearch(); });
  $("#searchInput").addEventListener("input", renderSearch);

  // settings modal
  $("#btnSettingsClose").addEventListener("click", closeSettings);
  $("#settingsOverlay").addEventListener("click", (e) => { if (e.target === $("#settingsOverlay")) closeSettings(); });

  // header avatar -> computer view
  $(".chat-header-left").addEventListener("click", (e) => {
    if (state.draft) return;
    if (e.target.closest(".avatar-wrap")) openDetails("computer");
  });

  // global keys
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if ($("#popoverLayer").classList.contains("open") && $$("#popoverLayer .popover").length) { closePopover(); return; }
      if (avatarEditorOpen) { setAvatarEditorOpen(false); return; }
      if (!$("#searchOverlay").hidden) { closeSearch(); return; }
      if (!$("#pluginsOverlay").hidden) { closePlugins(); return; }
      if (!$("#settingsOverlay").hidden) { closeSettings(); return; }
      if (state.draft) { state.draft = null; render(); return; }
      closePopover(); closeDropdown();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); openSearch(); }
  });

  // resizers
  makeResizer($("#sidebarResizer"), (dx) => {
    const w = $("#sidebar");
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) || 280;
    const next = Math.min(400, Math.max(220, cur + dx));
    document.documentElement.style.setProperty("--sidebar-w", next + "px");
  });
  makeResizer($("#detailsResizer"), (dx) => {
    const p = $("#detailsPanel");
    const next = Math.min(480, Math.max(260, p.offsetWidth - dx));
    p.style.width = next + "px";
  });
}
function makeResizer(el, onDx) {
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    let last = e.clientX;
    const move = (ev) => { onDx(ev.clientX - last); last = ev.clientX; };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/* ---------- boot ---------- */
function render() {
  if (!state.draft) closeDropdown();
  renderSidebar();
  renderHeader();
  renderTranscript();
  renderDetails();
  scrollBottom();
}
function scrollBottom() {
  const t = $("#transcript");
  t.scrollTop = t.scrollHeight;
}
state = loadState();
wire();
render();
