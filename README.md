# Wisp Bot

Wisp Bot gives you a squad of AI agents that work around the clock and actually get things done. Each one runs on its own computer, operates it the same way you would, and doesn't stop.

This repository contains an interactive mock UI of the Wisp Bot desktop app, built with [Electron](https://www.electronjs.org/), React 19, TypeScript 7, and Vite.

<p align="center">
  <img src="docs/screenshot.png" alt="Wisp Bot app screenshot" width="800" />
</p>

The renderer uses Tailwind CSS 4 and shadcn/ui with the Base Nova preset. shadcn components are copied into the project so they can be customized locally.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22.12 or later

### Install

```bash
npm install
```

### Develop

```bash
npm run dev
```

This starts Vite with fast refresh and opens the Electron app.

### Type-check

```bash
npm run typecheck
```

### Test

```bash
npm test
```

The backend boundary is covered by unit tests for request validation and the
deterministic fake conversation agent.

## AI model settings

The Electron main process uses the pinned `@earendil-works/pi-coding-agent`
SDK to provide the provider/model catalog. API keys are encrypted with
Electron's operating-system-backed `safeStorage` API and are never exposed to
the renderer. Wisp refuses to persist keys when secure storage is unavailable.

### Add shadcn components

```bash
npm run ui:add -- card
```

Replace `card` with any component available in the shadcn registry. Generated components are written to `src/components/ui`.

### Build and run

```bash
npm start
```

`npm start` type-checks the project, creates production builds for the React renderer and Electron main process, and launches the desktop app.

## Project Structure

```
wisp-bot/
├── electron/
│   └── main.ts          # Electron main process
├── src/
│   ├── App.tsx          # React application and UI components
│   ├── chat-data.ts     # Typed mock conversations
│   ├── components/wisp.tsx # Wisp agent avatar
│   ├── components/ui/   # Locally owned shadcn components
│   ├── lib/utils.ts     # Shared shadcn class-name utility
│   ├── main.tsx         # React renderer entry point
│   └── vite-env.d.ts    # Vite renderer declarations
├── components.json      # shadcn registry configuration
├── index.html           # Renderer HTML shell
├── styles.css           # Application styles
├── tsconfig.json        # React TypeScript configuration
├── tsconfig.electron.json
├── tsconfig.vite.json
└── vite.config.mts
```

## Roadmap

The mock UI is the first step. Upcoming work includes wiring the interface to real agents, persistence, and packaging installers.

## Contributing

Found a bug or have an idea? [Open an issue](https://github.com/gustmrg/wisp-bot/issues).

## License

[MIT](LICENSE)
