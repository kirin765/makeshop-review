import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8082);
const MS_BASE = "https://connect.makeshop.co.kr";
const TOKEN = process.env.PROXY_AUTH_TOKEN || "";

if (!TOKEN) {
  console.error("PROXY_AUTH_TOKEN not set — refusing to start");
  process.exit(1);
}
const TOKEN_BUF = Buffer.from(TOKEN, "utf8");

// 메이크샵 API 경로들: oauth 토큰 발급 · 설치 앱 정보 · 상품 · 후기(게시판)
const ALLOWED_PATH = /^\/(?:oauth|api)(?:\/|$)/;
const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept"]);

function tokenEquals(candidate) {
  const buf = Buffer.from(candidate, "utf8");
  if (buf.length !== TOKEN_BUF.length) return false;
  return timingSafeEqual(buf, TOKEN_BUF);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/healthz") return send(res, 200, { ok: true });

    if (!ALLOWED_PATH.test(url.pathname)) {
      return send(res, 404, { error: "path not allowed" });
    }

    const token = req.headers["x-proxy-token"];
    if (typeof token !== "string" || !tokenEquals(token)) {
      return send(res, 401, { error: "invalid proxy token" });
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (FORWARD_HEADERS.has(k.toLowerCase()) && typeof v === "string") {
        headers[k] = v;
      }
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const upstream = `${MS_BASE}${url.pathname}${url.search}`;
    const r = await fetch(upstream, { method: req.method, headers, body, redirect: "manual" });

    const respBody = Buffer.from(await r.arrayBuffer());
    const respHeaders = {};
    const skip = new Set(["transfer-encoding", "content-length", "connection", "content-encoding"]);
    for (const [k, v] of r.headers.entries()) {
      if (!skip.has(k.toLowerCase())) respHeaders[k] = v;
    }
    respHeaders["content-length"] = String(respBody.length);
    res.writeHead(r.status, respHeaders);
    res.end(respBody);
  } catch (e) {
    console.error("proxy error", e);
    send(res, 502, { error: "upstream failed", detail: String(e?.message ?? e) });
  }
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`makeshop proxy listening on ${HOST}:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(0));
}
