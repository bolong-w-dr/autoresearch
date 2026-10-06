// Thin client for the two things the dashboard talks to:
//   - the result store (static JSON under dataBaseUrl, written by the service)
//   - the command endpoint (POST apiBaseUrl/commands -> message queue)

const cfg = () => window.AUTORESEARCH_CONFIG || {};

async function getJson(url, { optional = false } = {}) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (res.status === 401 || res.status === 403) {
    // Session expired behind the SSO edge: reload so the edge function can redirect to the IdP.
    window.location.reload();
    throw new Error("not authenticated");
  }
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export const api = {
  index: () => getJson(`${cfg().dataBaseUrl}/index.json`),
  mission: (id) => getJson(`${cfg().dataBaseUrl}/missions/${encodeURIComponent(id)}.json`, { optional: true }),
  missionSchema: () => getJson(`${cfg().dataBaseUrl}/schema/mission.schema.json`),
  commandSchema: () => getJson(`${cfg().dataBaseUrl}/schema/command.schema.json`),
  me: () => getJson(`${cfg().apiBaseUrl}/me`, { optional: true }).catch(() => null),

  async sendCommand(command) {
    const res = await fetch(`${cfg().apiBaseUrl}/commands`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body && (body.detail || body.error || body.message);
      throw new Error(detail ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : `${res.status} ${res.statusText}`);
    }
    return body || { accepted: true };
  },
};

export function newRequestId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "req_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
