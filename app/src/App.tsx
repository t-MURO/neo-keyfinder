import { useCallback, useEffect, useState } from "react";
import {
  getNativeHealth,
  type NativeHealth,
} from "./lib/native-engine";

type EngineState =
  | { kind: "checking" }
  | { kind: "available"; health: NativeHealth }
  | { kind: "unavailable"; message: string };

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The native engine did not respond.";
}

export default function App() {
  const [engine, setEngine] = useState<EngineState>({ kind: "checking" });

  const checkEngine = useCallback(async () => {
    setEngine({ kind: "checking" });
    try {
      const health = await getNativeHealth();
      setEngine({ kind: "available", health });
    } catch (error) {
      setEngine({ kind: "unavailable", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void checkEngine();
  }, [checkEngine]);

  const isAvailable = engine.kind === "available";

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="KeyFinder home">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>KeyFinder</span>
        </a>
        <div
          className={`engine-pill engine-pill--${engine.kind}`}
          role="status"
          aria-live="polite"
        >
          <span className="status-dot" aria-hidden="true" />
          {engine.kind === "checking"
            ? "Checking engine"
            : isAvailable
              ? "Engine online"
              : "Engine offline"}
        </div>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Harmonic mixing, made legible</p>
            <h1 id="hero-title">
              Find the key.
              <br />
              <span>Keep the flow.</span>
            </h1>
            <p className="lede">
              A modern home for the trusted KeyFinder workflow. The analysis
              engine boundary is connected; track processing comes next.
            </p>
          </div>

          <aside className="engine-card" aria-labelledby="engine-card-title">
            <div className="engine-card__glow" aria-hidden="true" />
            <p className="card-kicker">System check</p>
            <h2 id="engine-card-title">
              {engine.kind === "checking" && "Contacting native engine…"}
              {isAvailable && "Ready for the next milestone"}
              {engine.kind === "unavailable" && "Native engine unavailable"}
            </h2>

            {isAvailable ? (
              <dl className="health-grid">
                <div>
                  <dt>Service</dt>
                  <dd>{engine.health.service}</dd>
                </div>
                <div>
                  <dt>Engine</dt>
                  <dd>v{engine.health.engineVersion}</dd>
                </div>
                <div>
                  <dt>Protocol</dt>
                  <dd>v{engine.health.protocolVersion}</dd>
                </div>
              </dl>
            ) : engine.kind === "unavailable" ? (
              <p className="engine-error">{engine.message}</p>
            ) : (
              <div className="health-skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            )}

            <button
              className="check-button"
              type="button"
              onClick={() => void checkEngine()}
              disabled={engine.kind === "checking"}
            >
              {engine.kind === "checking" ? "Checking…" : "Check again"}
            </button>
          </aside>
        </section>

        <section className="workflow" aria-labelledby="workflow-title">
          <div>
            <p className="section-index">01 — Foundation</p>
            <h2 id="workflow-title">One secure line from interface to engine.</h2>
          </div>
          <ol className="workflow-steps">
            <li>
              <span>Interface</span>
              <strong>React + TypeScript</strong>
            </li>
            <li>
              <span>Boundary</span>
              <strong>Typed Tauri command</strong>
            </li>
            <li>
              <span>Engine</span>
              <strong>C++ JSON-Lines sidecar</strong>
            </li>
          </ol>
        </section>
      </main>

      <footer>
        <span>KeyFinder rebuild</span>
        <span>Milestone 01</span>
      </footer>
    </div>
  );
}
