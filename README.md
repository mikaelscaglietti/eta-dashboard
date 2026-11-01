# ETA Dashboard

Answers dealership lead emails within seconds. The full plan is in
`ETA Dashboard Build Specification.md`, and the look is in `lead-responder-console.html`.

## Run it on your computer

Needs Node.js 24 or newer.

```bash
npm install
npm run setup-login
npm run dev
```

Then open http://localhost:3000.

## Check it

```bash
npm test
npm run typecheck
```

## Secrets

Keys and passwords never go in the code. On your computer they live in `.env`, which git
ignores. On the host they live in its environment settings.
