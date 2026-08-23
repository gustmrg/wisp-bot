# button

2026-08-23 — golden pair via CLI; the pristine Radix Nova wrapper was replaced with the official Base Nova wrapper.

## Changed

- `src/components/ui/button.tsx:1` now imports the real `Button` primitive from `@base-ui/react/button`; the Radix `Slot`/`asChild` implementation was removed while all existing variants and sizes were preserved.
- `components.json:3` now selects `base-nova`, so future shadcn additions resolve to Base UI implementations.
- `package.json:30` adds `@base-ui/react` and removes the direct `radix-ui` dependency; `package-lock.json` records the matching dependency swap.
- `README.md:7` now documents the Base Nova preset selected by the project.
- The consumer sweep found no Radix-only Button props in `src/App.tsx`, so its existing Button usages remain valid without edits.
- `grep -n "radix-ui\|@radix-ui" src/components/ui/button.tsx` returns no matches.

## Left alone

- `src/App.tsx` was intentionally unchanged because its Button consumers use only `variant`, `size`, standard button attributes, and event handlers supported by both wrappers.
- `styles.css` was intentionally unchanged because the Nova style, neutral theme, font, radius, and menu settings did not change.
- No cmdk, vaul, sonner, input-otp, react-day-picker, or recharts wrappers are installed in this project.

## Behavior changes

No runtime behavior change is expected for current consumers. The wrapper no longer exposes Radix's `asChild` API; future polymorphic composition must follow Base UI's `render` API, while links styled as buttons should use `buttonVariants` on a native anchor.

## Verify by hand

- Tab through the title-bar, attachment, and send buttons and activate each with Space and Enter.
- Confirm the title-bar ghost buttons and attachment outline button retain their previous appearance.
- Send a message with the black composer button and confirm the outgoing message and delayed reply both appear.
- Click the new-chat and attachment buttons and confirm focus moves to the composer input.
