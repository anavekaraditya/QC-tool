# Web Quality Audit Tool

An MVP quality-audit app for design and development teams. Users enter a live URL, optionally attach a Figma frame link, choose preset browser/device coverage, run an automated audit, and get an actionable report with evidence, affected environments, and fix guidance.

## Run Locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

If Playwright browsers are missing, install them:

```bash
npx playwright install
```

The app still starts without Playwright installed, but full browser/device screenshots require the dependency and browser binaries.

## Optional Figma Support

Set `FIGMA_TOKEN` to let the audit engine export a supplied Figma frame/node as the design reference:

```bash
FIGMA_TOKEN=figd_xxx npm run dev
```

V1 expects a node-specific Figma URL containing `node-id=...`.

## What V1 Checks

- URL reachability and page load health
- Desktop, tablet, and mobile browser presets
- Console errors and failed network requests
- Screenshots per environment
- Responsive overflow and tap-target basics
- Accessibility basics through axe-core when available
- Performance basics from browser timing metrics
- Figma reference export status and parity notes when a Figma link is provided

## API

- `POST /api/audits` starts an audit.
- `GET /api/audits/:id` returns job status and the report when complete.
- `GET /api/audits/:id/report.json` downloads the final report JSON.

Example payload:

```json
{
  "url": "https://example.com",
  "figmaUrl": "https://www.figma.com/design/fileKey/name?node-id=1-2",
  "matrix": ["desktop-chromium", "desktop-firefox", "mobile-webkit"]
}
```
