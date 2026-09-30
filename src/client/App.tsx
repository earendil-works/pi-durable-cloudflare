import { type FormEvent, useState } from "react";
import { ChatSession } from "./ChatSession.tsx";

const sessionRoute = /^\/sessions\/([^/]+)\/?$/;

export function App() {
  const pathname = window.location.pathname;
  if (pathname === "/") return <LandingPage />;

  const match = sessionRoute.exec(pathname);
  if (match !== null) {
    try {
      const sessionId = decodeURIComponent(match[1]);
      if (sessionId.length > 0) return <ChatSession sessionId={sessionId} />;
    } catch {
      // Render the not-found page below.
    }
  }

  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <a href="/">Return to the landing page</a>
      </p>
    </main>
  );
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const createSession = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
      const result = (await response.json()) as { readonly url?: unknown };
      if (typeof result.url !== "string")
        throw new Error("The server returned an invalid session URL");
      window.location.assign(result.url);
    } catch (error) {
      setCreating(false);
      setError(error instanceof Error ? error.message : "Session creation failed");
    }
  };

  return (
    <main>
      <header>
        <h1>pi-durable</h1>
        <p>A minimal chat interface for durable conversations and forks.</p>
      </header>
      <section aria-labelledby="create-session-heading">
        <h2 id="create-session-heading">Start a session</h2>
        <p>Create an isolated durable session, send messages, and fork its transcript.</p>
        <form onSubmit={createSession}>
          <button type="submit" disabled={creating}>
            {creating ? "Creating session…" : "Create session"}
          </button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
