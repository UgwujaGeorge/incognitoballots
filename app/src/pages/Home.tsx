import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

const UMBRELLA = '☂'
const COUNT = 18

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''
    for (let i = 0; i < COUNT; i++) {
      const el = document.createElement('span')
      el.className = 'umbrella'
      el.textContent = UMBRELLA
      el.style.left = `${Math.random() * 100}%`
      el.style.fontSize = `${18 + Math.random() * 26}px`
      el.style.animationDuration = `${8 + Math.random() * 16}s`
      el.style.animationDelay = `${Math.random() * 12}s`
      container.appendChild(el)
    }
  }, [])

  return (
    <section className="hero">
      <div className="umbrellas-container" ref={containerRef} />

      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
        }}>
          <span className="enc-badge">☂ Powered by Arcium MPC</span>
        </div>

        <h1 className="hero-title">Incognito Ballots</h1>

        <p className="hero-tagline">
          Truly private on-chain voting. Votes are encrypted before leaving your browser
          and tallied by Multi-Party Computation — nobody can see your vote or the running counts.
        </p>

        <div className="hero-ctas">
          <Link to="/create">
            <button className="btn-primary" style={{ fontSize: 16, padding: '14px 36px' }}>
              Create Proposal
            </button>
          </Link>
          <Link to="/browse">
            <button className="btn-secondary" style={{ fontSize: 15, padding: '14px 30px' }}>
              Browse Proposals
            </button>
          </Link>
        </div>

        <div style={{
          marginTop: 72,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
          gap: 24,
          maxWidth: 720,
          margin: '72px auto 0',
          textAlign: 'left',
        }}>
          {[
            { icon: '🔐', title: 'Encrypted Votes', desc: 'Each vote is encrypted client-side using x25519 + Rescue cipher.' },
            { icon: '🤝', title: 'MPC Tallying', desc: 'Arcium\'s MPC nodes compute the tally without ever seeing individual votes.' },
            { icon: '🔖', title: 'Token-Gated', desc: 'Only wallets holding the required SPL token can participate.' },
            { icon: '⛓', title: 'On-Chain Results', desc: 'Final tallies are stored on Solana devnet — transparent and immutable.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '20px', background: 'rgba(0,0,0,0.25)', borderRadius: 10, border: '1px solid rgba(212,168,83,0.15)' }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>{f.icon}</div>
              <div style={{ fontFamily: "'Cinzel',serif", fontSize: 14, color: 'var(--gold)', marginBottom: 6 }}>{f.title}</div>
              <div style={{ fontSize: 15, color: 'var(--cream-dim)', lineHeight: 1.5 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
