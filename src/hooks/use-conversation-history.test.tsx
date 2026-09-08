import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { expect, it, vi } from "vitest";
import { BackendProvider } from "@/features/backend/backend-provider";
import type { BackendApi } from "../../shared/backend-api";
import type { Chat, Message } from "../../shared/conversations";
import { useConversationHistory } from "./use-conversation-history";

const message = (id: string, text = id): Message => ({ id, type: "incoming", text, status: "complete" });
const chat = (messages: Message[]): Chat => ({
  id: "atlas",
  kind: "wisp",
  name: "Atlas",
  label: "",
  description: "",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  timestamp: "Now",
  preview: "",
  messages,
});
it("loads selected history pages and preserves earlier messages across bounded snapshots", async () => {
  const getConversationMessages = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { messages: [message("2"), message("3")], nextCursor: "2" } })
    .mockResolvedValueOnce({ ok: true, value: { messages: [message("1")], nextCursor: null } });
  const api = { getConversationMessages } as unknown as BackendApi;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider value={{ api, instanceId: "server", remote: true, writable: true }}>{children}</BackendProvider>
  );
  const hook = renderHook(({ snapshot }) => useConversationHistory(snapshot), {
    initialProps: { snapshot: chat([message("3")]) },
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.hasEarlier).toBe(true));
  expect(hook.result.current.chat?.messages.map(({ id }) => id)).toEqual(["2", "3"]);
  await act(() => hook.result.current.loadEarlier());
  expect(getConversationMessages).toHaveBeenLastCalledWith({ conversationId: "atlas", before: "2", limit: 200 });
  hook.rerender({ snapshot: chat([message("3", "Updated by server"), message("4")]) });
  expect(hook.result.current.chat?.messages.map(({ id }) => id)).toEqual(["1", "2", "3", "4"]);
  expect(hook.result.current.chat?.messages[2]).toMatchObject({ text: "Updated by server" });
  expect(hook.result.current.hasEarlier).toBe(false);
});

it("retains messages after more than twenty new messages roll out of the snapshot", async () => {
  const api = {
    getConversationMessages: vi.fn(async () => ({ ok: true, value: { messages: [message("0")], nextCursor: null } })),
  } as unknown as BackendApi;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider value={{ api, instanceId: "server", remote: true, writable: true }}>{children}</BackendProvider>
  );
  const hook = renderHook(({ snapshot }) => useConversationHistory(snapshot), {
    initialProps: { snapshot: chat([message("0")]) },
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.loadingHistory).toBe(false));
  const messages = [message("0")];
  for (let index = 1; index <= 45; index++) {
    messages.push(message(String(index)));
    hook.rerender({ snapshot: chat(messages.slice(-20)) });
  }
  expect(hook.result.current.chat?.messages.map(({ id }) => id)).toEqual(messages.map(({ id }) => id));
});

it("fills a reconnect gap larger than one page while retaining loaded older history", async () => {
  const messages = Array.from({ length: 451 }, (_, index) => message(String(index)));
  const getConversationMessages = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { messages: messages.slice(0, 20), nextCursor: null } })
    .mockResolvedValueOnce({ ok: true, value: { messages: messages.slice(251), nextCursor: "251" } })
    .mockResolvedValueOnce({ ok: true, value: { messages: messages.slice(51, 251), nextCursor: "51" } })
    .mockResolvedValueOnce({ ok: true, value: { messages: messages.slice(0, 51), nextCursor: null } });
  const api = { getConversationMessages } as unknown as BackendApi;
  let changeWritable: (next: boolean) => void = () => undefined;
  const wrapper = ({ children }: { children: ReactNode }) => {
    const [writable, setWritable] = useState(true);
    changeWritable = setWritable;
    return <BackendProvider value={{ api, instanceId: "server", remote: true, writable }}>{children}</BackendProvider>;
  };
  const hook = renderHook(({ snapshot }) => useConversationHistory(snapshot), {
    initialProps: { snapshot: chat(messages.slice(0, 20)) },
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.loadingHistory).toBe(false));
  act(() => changeWritable(false));
  hook.rerender({ snapshot: chat(messages.slice(-20)) });
  act(() => changeWritable(true));
  await waitFor(() => expect(getConversationMessages).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(hook.result.current.loadingHistory).toBe(false));
  expect(hook.result.current.chat?.messages.map(({ id }) => id)).toEqual(messages.map(({ id }) => id));
  expect(hook.result.current.hasEarlier).toBe(false);
});
