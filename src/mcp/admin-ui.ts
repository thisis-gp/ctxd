/** Minimal admin UI for per-user connector tokens (no build step). */

export function renderAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ctxd admin — connector tokens</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --card: #1a1d24; --text: #e8eaed; --muted: #9aa0a6; --accent: #8ab4f8; --danger: #f28b82; --ok: #81c995; --border: #2a2f3a; }
    @media (prefers-color-scheme: light) {
      :root { --bg: #f6f7f9; --card: #fff; --text: #202124; --muted: #5f6368; --accent: #1a73e8; --danger: #d93025; --ok: #188038; --border: #dadce0; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 1.5rem; margin: 0 0 8px; }
    p { color: var(--muted); line-height: 1.5; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin: 20px 0; }
    label { display: block; font-size: 0.85rem; margin-bottom: 6px; color: var(--muted); }
    input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); margin-bottom: 12px; }
    button { cursor: pointer; border: 0; border-radius: 8px; padding: 10px 14px; font-weight: 600; background: var(--accent); color: #fff; }
    button.danger { background: var(--danger); }
    button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
    .row > div { flex: 1; min-width: 160px; }
    .banner { padding: 12px; border-radius: 8px; background: #1e3a2f33; border: 1px solid var(--ok); color: var(--text); word-break: break-all; margin-top: 12px; display: none; }
    .err { color: var(--danger); font-size: 0.9rem; }
    code { font-family: ui-monospace, monospace; font-size: 0.85em; }
    .muted { color: var(--muted); font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>ctxd admin</h1>
    <p>Issue one connector token per Claude/Codex user. They authenticate to ctxd with that token — not Metabase. Queries still run in Metabase under each user's own access.</p>

    <div class="card">
      <label for="adminToken">Admin token (CTXD_ADMIN_TOKEN)</label>
      <div class="row">
        <div><input id="adminToken" type="password" placeholder="Bearer secret from server .env" autocomplete="off" /></div>
        <button type="button" id="saveAdmin">Save locally</button>
        <button type="button" class="ghost" id="reload">Refresh list</button>
      </div>
      <p class="muted">Stored only in this browser's sessionStorage.</p>
      <div id="authErr" class="err"></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1.1rem">Create token</h2>
      <div class="row">
        <div>
          <label for="name">User / bot name</label>
          <input id="name" placeholder="alice@company or analytics-bot" />
        </div>
        <button type="button" id="create">Create</button>
      </div>
      <div id="issued" class="banner"></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1.1rem">Tokens</h2>
      <table>
        <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
        <tbody id="rows"><tr><td colspan="5" class="muted">Sign in with admin token to load.</td></tr></tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1.1rem">User MCP config</h2>
      <p class="muted">Each user adds their own token:</p>
      <pre style="overflow:auto;background:transparent;border:1px solid var(--border);border-radius:8px;padding:12px"><code>{
  "mcpServers": {
    "ctxd": {
      "url": "https://YOUR_HOST/mcp",
      "headers": { "Authorization": "Bearer THEIR_TOKEN" }
    }
  }
}</code></pre>
    </div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const tokenKey = "ctxd_admin_token";
    $("adminToken").value = sessionStorage.getItem(tokenKey) || "";

    function adminHeaders() {
      const t = $("adminToken").value.trim();
      return { Authorization: "Bearer " + t, "Content-Type": "application/json" };
    }

    $("saveAdmin").onclick = () => {
      sessionStorage.setItem(tokenKey, $("adminToken").value.trim());
      $("authErr").textContent = "";
      loadTokens();
    };

    async function loadTokens() {
      $("authErr").textContent = "";
      try {
        const res = await fetch("/admin/api/tokens", { headers: adminHeaders() });
        if (!res.ok) {
          $("authErr").textContent = "Admin auth failed (" + res.status + ").";
          return;
        }
        const data = await res.json();
        const rows = $("rows");
        rows.innerHTML = "";
        if (!data.tokens.length) {
          rows.innerHTML = '<tr><td colspan="5" class="muted">No tokens yet.</td></tr>';
          return;
        }
        for (const t of data.tokens) {
          const tr = document.createElement("tr");
          const status = t.revokedAt ? "revoked" : "active";
          tr.innerHTML = "<td>" + escapeHtml(t.name) + "</td><td>" + escapeHtml(t.createdAt) + "</td><td>" +
            escapeHtml(t.lastUsedAt || "—") + "</td><td>" + status + "</td><td></td>";
          if (!t.revokedAt) {
            const btn = document.createElement("button");
            btn.className = "danger";
            btn.textContent = "Revoke";
            btn.onclick = async () => {
              if (!confirm("Revoke token for " + t.name + "?")) return;
              await fetch("/admin/api/tokens/" + t.id + "/revoke", { method: "POST", headers: adminHeaders() });
              loadTokens();
            };
            tr.lastChild.appendChild(btn);
          }
          rows.appendChild(tr);
        }
      } catch (e) {
        $("authErr").textContent = String(e.message || e);
      }
    }

    $("reload").onclick = loadTokens;

    $("create").onclick = async () => {
      $("issued").style.display = "none";
      const name = $("name").value.trim();
      if (!name) return alert("Name required");
      const res = await fetch("/admin/api/tokens", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        $("authErr").textContent = data.error || "Create failed";
        return;
      }
      $("issued").style.display = "block";
      $("issued").innerHTML = "<strong>Copy now — shown once</strong><br/><code>" + escapeHtml(data.token) +
        "</code><br/><span class='muted'>" + escapeHtml(data.note) + "</span>";
      $("name").value = "";
      loadTokens();
    };

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    if ($("adminToken").value) loadTokens();
  </script>
</body>
</html>`;
}
