"use client";

/**
 * The password gate (§43).
 *
 * One field, one button. The password is posted to the server and checked
 * there — it is never compared in the browser and never appears in the
 * bundle. On success the server sets an HttpOnly cookie and the user is sent
 * on to the tool.
 */

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const candidate = password.trim();
    if (!candidate || checking) return;

    setChecking(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: candidate }),
      });

      if (response.ok) {
        // Full navigation, not a client route change: the new cookie has to be
        // presented to middleware for the destination to be allowed.
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.href = next && next.startsWith("/") ? next : "/";
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(body.error ?? "Something went wrong. Please try again.");
      setPassword("");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <main style={{ maxWidth: "24rem", paddingTop: "6rem" }}>
      <div className="card">
        <h1 style={{ fontSize: "1.25rem", marginBottom: "0.35rem" }}>
          Mark it Down
        </h1>
        <p className="muted" style={{ marginBottom: "1.5rem" }}>
          Enter the access password to continue.
        </p>

        <form onSubmit={submit}>
          <label htmlFor="password" className="visually-hidden">
            Access password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "password-error" : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setError("");
            }}
            style={{
              width: "100%",
              padding: "0.7rem 0.9rem",
              fontSize: "1rem",
              fontFamily: "inherit",
              color: "var(--text)",
              background: "var(--bg)",
              border: `1px solid ${error ? "var(--danger)" : "var(--border-strong)"}`,
              borderRadius: 8,
              boxSizing: "border-box",
            }}
          />

          {/* §54 - the failure is announced, and not signalled by colour alone. */}
          {error && (
            <p
              id="password-error"
              role="alert"
              style={{
                color: "var(--danger)",
                fontSize: "0.85rem",
                margin: "0.5rem 0 0",
              }}
            >
              {error}
            </p>
          )}

          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={!password.trim() || checking}
              style={{ width: "100%" }}
            >
              {checking ? "Checking…" : "Continue"}
            </button>
          </div>
        </form>
      </div>

      <div className="footnote">
        <p>
          Files are processed temporarily and deleted automatically. No AI model
          is used.
        </p>
      </div>
    </main>
  );
}
