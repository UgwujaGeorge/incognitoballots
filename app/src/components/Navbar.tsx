import { Link } from 'react-router-dom'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'

export default function Navbar() {
  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand">
        <span>☂</span> Incognito Ballots
      </Link>
      <div className="navbar-links">
        <Link to="/browse">Browse</Link>
        <Link to="/create">Create Proposal</Link>
        <WalletMultiButton style={{
          background: 'linear-gradient(135deg,#b8842a,#d4a853)',
          color: '#1a0f0a',
          fontFamily: "'Cinzel',serif",
          fontSize: '13px',
          height: '38px',
          borderRadius: '6px',
          fontWeight: 700,
          letterSpacing: '0.05em',
          border: '1px solid rgba(255,255,255,0.15)',
        }} />
      </div>
    </nav>
  )
}
