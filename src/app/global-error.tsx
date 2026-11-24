"use client";

/** Last-resort boundary when the root layout itself fails: self-contained, bilingual, no app context. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="fr-CA">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#151b2b", color: "#f4efe4", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: 16 }}>
        <main>
          <h1 style={{ fontSize: 28 }}>Interruption de service · Service interruption</h1>
          <p style={{ opacity: 0.75 }}>Réessayez dans un instant. · Please try again in a moment.</p>
          <button type="button" onClick={reset} style={{ marginTop: 16, height: 44, padding: "0 20px", borderRadius: 999, border: 0, background: "#f39c3d", color: "#151b2b", fontWeight: 700, cursor: "pointer" }}>
            Réessayer · Try again
          </button>
        </main>
      </body>
    </html>
  );
}
