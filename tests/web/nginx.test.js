// Every API path the phone page calls must be let through by the nginx allowlist (deploy/nginx-agent-bridge.conf):
// anything else is a 404 for the phone even though the Bridge has the endpoint.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const conf = fs.readFileSync(path.join(__dirname, "../../deploy/nginx-agent-bridge.conf"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8");

const patterns = [];
for (const m of conf.matchAll(/location\s+(=|~)\s+("([^"]+)"|(\S+))\s*\{([^}]*)\}/g)) {
  const body = m[5];
  const allowed = ((/limit_except\s+([^{]+)\{/.exec(body) || [])[1] || "GET").trim().split(/\s+/);
  const source = m[3] || m[4];
  patterns.push({ re: m[1] === "=" ? new RegExp("^" + source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") : new RegExp(source), method: allowed });
}

const UUID = "0199aaaa-0000-7000-8000-000000000001";
let checked = 0;
for (const m of js.matchAll(/api\(\s*"(GET|POST)"\s*,\s*([`"])([^`"]*)\2/g)) {
  const route = m[3].replace(/\$\{[^}]*\}/g, (hole, at, whole) => (whole[at - 1] === "/" ? UUID : "")).split("?")[0];
  if (!route.startsWith("/")) continue;
  // ids differ by route: sessions use UUIDs, tasks and approvals 32 hex digits
  const candidates = route.endsWith("/") ? [route + UUID, route + "0".repeat(32)] : [route, route.replace(UUID, "0".repeat(32))];   // "/approvals/" + id
  const ok = candidates.some((r) => patterns.some((p) => p.re.test(r) && p.method.includes(m[1])));
  assert(ok, `${m[1]} ${route} is not allowed by the nginx allowlist`);
  checked++;
}
assert(checked > 10, "found the page's API calls");
console.log(`${checked} page API calls are covered by the nginx allowlist`);
