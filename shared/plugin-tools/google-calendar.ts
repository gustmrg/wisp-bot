import type { PluginToolMetadata } from "./types.js";

export const GOOGLE_CALENDAR_TOOL_METADATA = {
  listCalendars: {
    name: "google_calendar_list_calendars",
    label: "List Google calendars",
    activityLabel: "Listing calendars…",
    category: "read",
  },
  listEvents: {
    name: "google_calendar_list_events",
    label: "List calendar events",
    activityLabel: "Reading the calendar…",
    category: "search",
  },
  getEvent: {
    name: "google_calendar_get_event",
    label: "Read calendar event",
    activityLabel: "Reading a calendar event…",
    category: "read",
  },
  freeBusy: {
    name: "google_calendar_free_busy",
    label: "Check free and busy times",
    activityLabel: "Checking availability…",
    category: "read",
  },
  createEvent: {
    name: "google_calendar_create_event",
    label: "Create calendar event",
    activityLabel: "Creating a calendar event…",
    category: "external_write",
  },
  updateEvent: {
    name: "google_calendar_update_event",
    label: "Update calendar event",
    activityLabel: "Updating a calendar event…",
    category: "external_write",
  },
  respondToEvent: {
    name: "google_calendar_respond_to_event",
    label: "Respond to invitation",
    activityLabel: "Responding to an invitation…",
    category: "external_write",
  },
} as const satisfies Record<string, PluginToolMetadata>;
