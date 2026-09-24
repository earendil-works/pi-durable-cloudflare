export { Session } from "./session.ts";

const route = /^\/sessions\/([^/]+)\/?$/;

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

// Add authentication and production error handling:
// https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
export default {
  async fetch(request, env): Promise<Response> {
    const match = route.exec(new URL(request.url).pathname);
    if (match === null) return json({ error: "Not found" }, 404);

    let name: string;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      return json({ error: "Invalid session name" }, 400);
    }
    const session = env.SESSIONS.getByName(name);
    switch (request.method) {
      case "POST": {
        const result = await session.createRoot();
        return json(result.conversation, result.created ? 201 : 200);
      }
      case "GET": {
        const conversation = await session.root();
        return conversation === undefined
          ? json({ error: "Session not found" }, 404)
          : json(conversation, 200);
      }
      default:
        return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
    }
  },
} satisfies ExportedHandler<Env>;
