import { RadioTower } from "lucide-react";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="home-shell">
      <nav className="home-nav">
        <span className="brand-lockup">
          <RadioTower size={21} /> Informant <small>LOCAL CI</small>
        </span>
        <Link href="/docs">Read the field manual →</Link>
      </nav>
      <section className="hero">
        <div className="eyebrow">
          <span className="live-dot" /> Worker 03 is listening · no inbound ports
        </div>
        <h1>
          Your machines.<em>On CI duty.</em>
        </h1>
        <p className="hero-copy">
          Informant turns idle Macs into a private CI fleet. GitHub is the queue. Tart is the
          isolation. Nothing needs a public endpoint.
        </p>
        <div className="actions">
          <Link className="button" href="/docs/quickstart">
            Start reporting
          </Link>
          <a className="button secondary" href="https://github.com/InformantDev/informant">
            View source
          </a>
        </div>
        <div className="terminal" role="log" aria-label="Example Informant terminal output">
          <div className="terminal-head">
            <span>INFORMANT / MAC-MINI-03</span>
            <span>LIVE</span>
          </div>
          <pre>
            <b>●</b> polling acme/widgets every 20s{"\n"}
            <b>→</b> found 7ad93c1 on main{"\n"}
            <b>✓</b> won distributed check claim #1842{"\n"}
            <b>→</b> tart clone macos-tahoe-base build-b71f{"\n"}
            <b>✓</b> test 01:42{"\n"}
            <b>✓</b> typecheck 00:19{"\n"}
            <b>✓</b> GitHub check completed
          </pre>
        </div>
        <div className="feature-strip">
          <div className="feature">
            <strong>01 / Invisible</strong>Polls outward to GitHub. No webhook tunnel, firewall
            rule, or public server.
          </div>
          <div className="feature">
            <strong>02 / Disposable</strong>Every commit runs in a fresh Tart VM built from your
            chosen macOS image.
          </div>
          <div className="feature">
            <strong>03 / Distributed</strong>Add another Mac. Checks coordinate claims; the fleet
            balances itself.
          </div>
        </div>
      </section>
    </main>
  );
}
