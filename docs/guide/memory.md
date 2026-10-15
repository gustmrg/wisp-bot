---
title: Context and memory
summary: How a Wisp keeps context, automatic context renewal, summarizing, starting a new topic, saved memory that survives every topic, and finding earlier messages.
---
# Context and memory

Open the Wisp's [Context & memory](wisp://wisp/memory) settings.

## Context renewal

By default, the next message after 24 hours of inactivity starts a new topic,
but only when the active context is at least 12,000 tokens. **Renew context**
can follow inactivity or a daily hour (in your timezone from
[General](wisp://settings/general)), and **On renewal** either starts a new
topic or **Summarize and continue**. A summary keeps goals, decisions and
pending work but costs a summarization request; a new topic sends the fewest
tokens. The thresholds are adjustable.

## Summaries and new topics

**Summarize context** condenses the conversation and keeps its recent part;
**View continuity summary** shows the current summary. **Start new topic**
clears the active context while keeping every message on screen and the
Wisp's identity, model and saved memory. A marker in the conversation shows
each boundary.

Either way the Wisp can still find earlier messages by searching its history.

## Saved memory

**Saved memory** is text you write: preferences and facts to keep across
topics. It is sent with every request and survives new topics and restarts.
Wisps never add to it on their own.
