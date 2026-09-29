export { Session } from "./session.ts";

const route = /^\/session\/([^/]+)(?:\/prompt)?\/?$/;

const json = (body: unknown, status: number): Response => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = route.exec(new URL(request.url).pathname);
    if (match === null) return json({ error: "Not found" }, 404);

    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return json({ error: "Invalid session ID" }, 400);
    }

    // Demo-only surface: add authentication before exposing model-backed routes publicly.
    return env.SESSIONS.getByName(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
