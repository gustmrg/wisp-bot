# ADR 038: A phone keeps the mobile layout in any orientation

- Status: Accepted
- Date: 2026-10-30
- Decision owners: Wisp renderer
- Scope: How the renderer decides between the mobile layout and the desktop panels
- Related: [mobile layout](../mobile-layout.md), [ADR 015](015-mobile-bottom-bar.md),
  [ADR 018](018-native-mobile-app.md)

## Context

The renderer chose its layout from the window's width alone: 760px or less was
the mobile layout. A phone on its side is wider than that on most models. An
iPhone 15 measures 852x393, so turning it brought up the sidebar and the
desktop panels, a layout never designed for 393px of height. An iPhone SE, at
667x375, stayed in the mobile layout, so the same gesture did different things
on different phones.

Turning the phone also switched layouts under whatever was on screen. Leaving
the mobile layout made the active conversation count as shown, so a phone
turned while on the list marked that conversation read.

Measured in Chromium with device emulation, in CSS pixels:

| Device | Window | Width only | Height and touch | Screen's sides |
|---|---|---|---|---|
| iPhone 15, sideways | 852x393 | desktop | mobile | mobile |
| Pixel 8, sideways | 915x412 | desktop | mobile | mobile |
| Largest iPhone, sideways | 956x440 | desktop | mobile | mobile |
| iPhone SE, sideways | 667x375 | mobile | mobile | mobile |
| iPad, either way | 1180x820, 820x1180 | desktop | desktop | desktop |
| Android tablet, sideways | 1280x800 | desktop | desktop | desktop |
| Android tablet, sideways, keyboard open | 1280x420 | desktop | mobile | desktop |
| Desktop window, short | 900x450 | desktop | desktop | desktop |

## Decision

**The mobile layout applies to a narrow window, or to any device whose screen
has a side shorter than 600px.**

```css
@media (max-width: 760px), (max-device-width: 599px), (max-device-height: 599px)
```

- A phone keeps the mobile layout on its side, with no sidebar. Landscape stays
  available; nothing locks the orientation.
- Both of the screen's sides are checked because iOS always reports the screen
  in portrait, while Android swaps its sides when it turns.
- 600px is where tablets start. It is the value Android itself uses to tell a
  tablet from a phone.
- `useMobileLayout` and the rules in `mobile.css` and `aura.css` state the same
  query, and a test keeps them equal. The `max-[760px]` and `min-[761px]`
  classes stay as they are: they fit content to the width, and do not choose a
  layout.

## Consequences

- Turning a phone no longer switches layouts, so the open screen and its draft
  stay as they were, and the list no longer marks a conversation read.
- The keyboard cannot change the layout. It shrinks the window on Android, but
  not the screen.
- `device-width` and `device-height` are deprecated in favor of `width` and
  `height`, because they say nothing about the window. That is what is wanted
  here. Browsers keep supporting them, and the build compiles them to the same
  range syntax it already uses for `width`.
- A small display on a desktop, such as an 800x480 touchscreen, now gets the
  mobile layout, which suits it better than the sidebar.

## Deferred

- A layout designed for landscape. With the keyboard open on a phone on its
  side, little of the conversation is left between the header and the composer:
  about 74px in a 200px window. It works, and a shorter header could give it
  more room.

## Decisions taken with the user

- With no layout designed for landscape, the phone stays in the mobile layout
  and never shows the sidebar.

## Rejected alternatives

- **Locking the phone to portrait.** There is no native app to configure
  ([ADR 018](018-native-mobile-app.md) is a proposal), the web app manifest's
  `orientation` and `screen.orientation.lock()` cannot be relied on in iOS, and
  iOS is where this was found.
- **A higher width breakpoint.** Phones on their side reach 956px, while iPads
  start at 820px and a desktop window can be any width. No width separates them.
- **`max-height` with `pointer: coarse`.** It handles every phone, but on an
  Android tablet the keyboard shrinks the window below the limit, and the layout
  would change while the person types.
- **Reading the screen in JavaScript and setting an attribute.** It would mean
  rewriting every rule in `mobile.css`, for a condition a media query can state.
