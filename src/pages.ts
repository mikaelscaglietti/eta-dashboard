// Colors, font, and spacing are copied from lead-responder-console.html.
const styles = `
:root{
  --bg:#f4f5f7;--surface:#fff;--ink:#14181f;--muted:#5b6575;--line:#dde1e8;
  --side:#10161f;--side-ink:#b9c3d3;--accent:#2b4fe0;--accent-ink:#fff;
  --bad:#b0241a;--bad-bg:#fbe5e2;
  --font:'Barlow Condensed','Arial Narrow',Arial,sans-serif;
}
@media (prefers-color-scheme: dark){:root{
  color-scheme:dark;
  --bg:#0c1016;--surface:#151b24;--ink:#e9edf3;--muted:#9aa5b6;--line:#263040;
  --side:#080b10;--side-ink:#a5b0c2;--accent:#7d98ff;--accent-ink:#0b1020;
  --bad:#ff8f84;--bad-bg:#3b1714;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 var(--font);-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1{font-size:24px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px;font-weight:700}
.sub{color:var(--muted);margin:0 0 22px}
.brand{color:#fff;font-weight:700;font-size:24px;letter-spacing:.06em;padding-bottom:18px;border-bottom:1px solid #2a3547}
.btn{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600;font-size:14px}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);width:100%}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}
.card{width:100%;max-width:380px;background:var(--side);border-radius:12px;padding:22px}
.panel{background:var(--surface);border-radius:10px;padding:18px;margin-top:18px}
.field{display:flex;flex-direction:column;gap:5px;margin-bottom:16px}
.field label{font-weight:600;font-size:14px}
.field input{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}
.banner{background:var(--bad-bg);color:var(--bad);border:1px solid var(--bad);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-weight:500}
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{background:var(--side);color:var(--side-ink);padding:18px 14px;display:flex;flex-direction:column;justify-content:space-between}
main{padding:28px clamp(16px,3vw,40px) 60px}
@media (max-width:820px){.app{grid-template-columns:1fr}.side{gap:12px}}
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${styles}</style>
</head>
<body>${body}</body>
</html>`;
}

export function loginPage(failed = false): string {
  return page('Sign in: ETA Dashboard', `<div class="login"><div class="card">
  <div class="brand">ETA DASHBOARD</div>
  <form class="panel" method="post" action="/login">
    <h1>Sign in</h1>
    <p class="sub">Use your owner account.</p>
    ${failed ? '<div class="banner" role="alert">That email or password isn’t right.</div>' : ''}
    <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" type="submit">Sign in</button>
  </form>
</div></div>`);
}

export function homePage(): string {
  return page('ETA Dashboard', `<div class="app">
  <aside class="side">
    <div class="brand">ETA DASHBOARD</div>
    <form method="post" action="/logout"><button class="btn" type="submit">Sign out</button></form>
  </aside>
  <main>
    <h1>Setup in progress</h1>
    <p class="sub">You’re signed in. The dashboard screens arrive in the next build steps.</p>
  </main>
</div>`);
}
