export { Session } from "./session.ts";

const connectRoute = /^\/api\/sessions\/([^/]+)\/connect\/?$/;

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const sessionIdFromMatch = (value: string): string | undefined => {
  try {
    const id = decodeURIComponent(value);
    return id.length > 0 && id.length <= 128 ? id : undefined;
  } catch {
    return undefined;
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/sessions" || url.pathname === "/api/sessions/") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      const sessionId = crypto.randomUUID();
      return json({ sessionId, url: `/sessions/${sessionId}` }, 201);
    }

    const connect = connectRoute.exec(url.pathname);
    if (connect !== null) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      const id = sessionIdFromMatch(connect[1]);
      if (id === undefined) return json({ error: "Invalid session ID" }, 400);
      // Demo-only surface: add authentication before exposing model-backed routes publicly.
      return env.SESSIONS.getByName(id).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
