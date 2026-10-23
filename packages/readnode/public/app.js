const FARCASTER_EPOCH_SECONDS = 1609459200;

const el = (id) => document.getElementById(id);
let state = null;
let feedClients = [];
let toastTimer = null;

function fcTimeToDate(seconds) {
  return new Date((FARCASTER_EPOCH_SECONDS + seconds) * 1000);
}

function shortHash(hash) {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function shortKey(key) {
  return `${key.slice(0, 10)}…${key.slice(-6)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(message, bad = false) {
  const node = el("toast");
  node.textContent = message;
  node.classList.toggle("bad", bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

function facts(target, entries) {
  target.innerHTML = entries
    .map(([label, value, className]) => {
      const cls = className ? ` class="${className}"` : "";
      return `<dt>${escapeHtml(label)}</dt><dd${cls}>${value}</dd>`;
    })
    .join("");
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    const dot = el("node-dot");
    if (health.ok) {
      dot.classList.add("ok");
      dot.classList.remove("bad");
      const worst = Math.max(...health.shardInfos.map((s) => s.blockDelay), 0);
      el("node-meta").textContent = `v${health.version} · lag ${worst}s`;
    } else {
      dot.classList.add("bad");
      el("node-meta").textContent = "node unreachable";
    }
  } catch (error) {
    el("node-meta").textContent = String(error.message ?? error);
  }
}

function renderAccountFacts() {
  const target = el("account-facts");
  if (!state.custodyAddress) {
    target.innerHTML = "";
    return;
  }
  const entries = [["custody", escapeHtml(state.custodyAddress)]];
  if (state.fid) {
    entries.push(["fid", String(state.fid)]);
    entries.push([
      "custody match",
      state.custodyMatches ? "yes" : "no — this FID is owned by another address",
      state.custodyMatches ? "ok" : "bad",
    ]);
  } else {
    entries.push([
      "fid",
      "none — this address is not registered as a Farcaster custody address",
      "bad",
    ]);
  }
  if (state.storage) {
    const casts = state.storage.casts;
    if (casts) entries.push(["storage", `${casts.used} / ${casts.limit} casts used`]);
  }
  facts(target, entries);
}

function renderSignerFacts() {
  const target = el("signer-facts");
  if (!state.signer) {
    target.innerHTML = "";
    return;
  }
  const expires = new Date(state.signer.expiresAt * 1000);
  const days = Math.max(
    0,
    Math.round((expires.getTime() - Date.now()) / 86400000),
  );
  facts(target, [
    ["app key", escapeHtml(shortKey(state.signer.publicKey))],
    ["request fid", String(state.signer.requestFid)],
    ["scopes", escapeHtml(state.signer.scopes.join(", "))],
    ["expires", `${expires.toISOString().slice(0, 10)} (${days}d, sliding)`],
  ]);
}

function clientLabel(client) {
  if (client.requestFid !== undefined && client.requestFid === state.signer?.requestFid) {
    return "this client";
  }
  if (client.label && client.label !== client.id) return client.label;
  return client.id.startsWith("key:") ? `key ${shortKey(client.id.slice(4))}` : client.id;
}

function renderFilters() {
  const target = el("client-list");
  // Clients in the current feed, plus any the filter names that aren't in it.
  const clients = [...feedClients];
  for (const id of [...state.filter.include, ...state.filter.exclude]) {
    if (!clients.some((c) => c.id === id)) clients.push({ id, label: id, casts: 0 });
  }
  if (clients.length === 0) {
    target.innerHTML =
      '<p class="hint">No clients seen yet. They appear as casts load.</p>';
    return;
  }
  target.innerHTML = clients
    .map((client) => {
      const included = state.filter.include.includes(client.id);
      const excluded = state.filter.exclude.includes(client.id);
      return `<div class="client" data-id="${escapeHtml(client.id)}">
        <span class="id"><b>${escapeHtml(clientLabel(client))}</b> · ${client.casts} cast${client.casts === 1 ? "" : "s"}<br><small title="${escapeHtml(client.id)}">${escapeHtml(client.id)}</small></span>
        <span class="mode">
          <button data-mode="include" class="${included ? "active" : ""}">only</button>
          <button data-mode="exclude" class="${excluded ? "active" : ""}">hide</button>
        </span>
      </div>`;
    })
    .join("");

  for (const button of target.querySelectorAll("button[data-mode]")) {
    button.addEventListener("click", () => toggleFilter(button));
  }
}

async function toggleFilter(button) {
  const id = button.closest(".client").dataset.id;
  const mode = button.dataset.mode;
  const include = new Set(state.filter.include);
  const exclude = new Set(state.filter.exclude);

  if (mode === "include") {
    include.has(id) ? include.delete(id) : include.add(id);
  } else {
    exclude.has(id) ? exclude.delete(id) : exclude.add(id);
  }

  state.filter = { include: [...include], exclude: [...exclude] };
  await api("/api/filter", { method: "POST", body: state.filter });
  renderFilters();
  await loadFeed();
}

async function loadFeed() {
  const target = el("feed");
  target.innerHTML = '<p class="hint">Loading from your node…</p>';
  try {
    const { entries, clients } = await api("/api/feed?limit=25");
    feedClients = clients ?? [];
    renderFilters();
    if (entries.length === 0) {
      target.innerHTML = '<p class="hint">No casts match the current filter.</p>';
      return;
    }
    target.innerHTML = entries.map(renderCast).join("");
    for (const button of target.querySelectorAll("button[data-action]")) {
      button.addEventListener("click", () => castAction(button));
    }
  } catch (error) {
    target.innerHTML = `<p class="hint bad">${escapeHtml(error.message)}</p>`;
  }
}

function renderCast(entry) {
  const who = entry.author.username
    ? `@${entry.author.username}`
    : `fid ${entry.fid}`;
  const avatar = entry.author.pfpUrl
    ? `<img class="avatar" src="${escapeHtml(entry.author.pfpUrl)}" alt="">`
    : "";
  const parent = entry.parent
    ? `<div class="hint">replying to ${escapeHtml(shortHash(entry.parent.hash))}</div>`
    : "";
  return `<article class="cast">
    <div class="cast-head">
      ${avatar}
      <button class="linklike" data-action="profile" data-fid="${entry.fid}">${escapeHtml(who)}</button>
      <span>${fcTimeToDate(entry.timestamp).toISOString().slice(0, 16).replace("T", " ")}</span>
      <span class="badge${entry.isOwn ? " own" : ""}">via ${escapeHtml(entry.clientId === `fid:${state.signer?.requestFid}` ? "this client" : entry.clientLabel)}</span>
    </div>
    ${parent}
    <div class="cast-text">${escapeHtml(entry.text)}</div>
    <div class="cast-actions">
      <button data-action="like" data-fid="${entry.fid}" data-hash="${entry.hash}">Like</button>
      <button data-action="recast" data-fid="${entry.fid}" data-hash="${entry.hash}">Recast</button>
      <button data-action="reply" data-fid="${entry.fid}" data-hash="${entry.hash}">Reply</button>
      <button data-action="follow" data-fid="${entry.fid}">Follow</button>
    </div>
  </article>`;
}

async function castAction(button) {
  const { action, fid, hash } = button.dataset;
  try {
    if (action === "like" || action === "recast") {
      await api("/api/react", {
        method: "POST",
        body: {
          fid: Number(fid),
          hash,
          type: action === "recast" ? "Recast" : "Like",
        },
      });
      toast(action === "like" ? "Liked" : "Recast");
    } else if (action === "follow") {
      await api("/api/follow", { method: "POST", body: { fid: Number(fid) } });
      toast(`Now following fid ${fid}`);
    } else if (action === "reply") {
      el("compose-text").focus();
      el("compose-hint").textContent = `replying to ${shortHash(hash)}`;
      el("compose-text").dataset.parentFid = fid;
      el("compose-text").dataset.parentHash = hash;
    } else if (action === "profile") {
      await showProfile(Number(fid));
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function showProfile(fid) {
  const panel = el("profile-panel");
  const body = el("profile-body");
  const data = await api(`/api/profile?fid=${fid}`);
  el("profile-title").textContent = data.profile.username
    ? `@${data.profile.username}`
    : `fid ${fid}`;
  body.innerHTML = `
    <p class="hint">${escapeHtml(data.profile.displayName ?? "")}</p>
    <p class="cast-text">${escapeHtml(data.profile.bio ?? "")}</p>
    <p class="hint">${data.signers.length} app key(s) · ${
      data.signers.filter((s) => s.requestFid !== undefined).length
    } with a request FID</p>
    <button id="profile-follow">Follow fid ${fid}</button>
  `;
  panel.hidden = false;
  el("profile-follow").addEventListener("click", async () => {
    await api("/api/follow", { method: "POST", body: { fid } });
    toast(`Now following fid ${fid}`);
  });
}

function render() {
  el("onboarding").hidden = Boolean(state.signer && state.fid);
  el("app").hidden = !state.fid;
  el("issue").disabled = !state.fid || Boolean(state.signer);
  renderAccountFacts();
  renderSignerFacts();
  renderFilters();
}

async function refreshState() {
  state = await api("/api/state");
  render();
}

el("import").addEventListener("click", async () => {
  const mnemonic = el("mnemonic").value.trim();
  if (!mnemonic) return toast("Paste a seed phrase first.", true);
  try {
    state = await api("/api/session", { method: "POST", body: { mnemonic } });
    render();
    if (!state.fid) toast("That address has no FID on Optimism.", true);
    else await loadFeed();
  } catch (error) {
    toast(error.message, true);
  }
});

el("issue").addEventListener("click", async () => {
  const mnemonic = el("mnemonic").value.trim();
  if (!mnemonic) return toast("Re-enter the seed phrase to authorize.", true);
  el("issue").disabled = true;
  try {
    state = await api("/api/signer", { method: "POST", body: { mnemonic } });
    el("mnemonic").value = "";
    render();
    toast("App key issued — signed by your node, no gas.");
    await loadFeed();
  } catch (error) {
    el("issue").disabled = false;
    toast(error.message, true);
  }
});

el("publish").addEventListener("click", async () => {
  const box = el("compose-text");
  const text = box.value.trim();
  if (!text) return toast("Nothing to cast.", true);
  try {
    await api("/api/cast", {
      method: "POST",
      body: {
        text,
        parentFid: box.dataset.parentFid,
        parentHash: box.dataset.parentHash,
      },
    });
    box.value = "";
    delete box.dataset.parentFid;
    delete box.dataset.parentHash;
    el("compose-hint").textContent = "";
    toast("Cast submitted");
    setTimeout(loadFeed, 1500);
  } catch (error) {
    toast(error.message, true);
  }
});

el("refresh").addEventListener("click", () => loadFeed());
el("profile-close").addEventListener("click", () => {
  el("profile-panel").hidden = true;
});

(async () => {
  await checkHealth();
  setInterval(checkHealth, 15000);
  try {
    await refreshState();
    if (state.fid) await loadFeed();
  } catch (error) {
    toast(error.message, true);
  }
})();
