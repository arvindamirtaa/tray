# Tray

Tray is a durable, auditable agent workflow prototype built for Daytona HackSprint SF.

## Development

Copy `.env.example` to `.env`, add the required API keys, and install dependencies:

```sh
cp .env.example .env
npm install
```

## Disclosure

GroundCore (the append-only event store, vendored as a prebuilt `groundhog` binary) is a pre-existing personal project. Everything else — the Tray service, Daytona execution, approval flow, UI, and Braintrust integration — was built during Daytona HackSprint SF, July 24, 2026.

