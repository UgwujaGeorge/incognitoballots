import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection } from '@solana/wallet-adapter-react'
import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor'
import { PublicKey, Keypair } from '@solana/web3.js'
import idl from '../../idl/incognitoballots.json'

interface ProposalAccount {
  publicKey: PublicKey
  account: {
    title: string
    option0: string; option1: string; option2: string; option3: string; option4: string
    startTime: { toNumber(): number }
    endTime: { toNumber(): number }
    isFinalized: boolean
    authority: PublicKey
    requiredTokenMint: PublicKey
    minTokenAmount: { toNumber(): number }
  }
}

export default function BrowseProposals() {
  const { connection } = useConnection()
  const navigate = useNavigate()
  const [proposals, setProposals] = useState<ProposalAccount[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const dummy = Keypair.generate()
        const provider = new AnchorProvider(connection, { publicKey: dummy.publicKey, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs }, { commitment: 'confirmed' })
        const program = new Program(idl as Idl, provider)
        const all = await (program.account as any).proposal.all()
        setProposals(all)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [connection])

  const now = Math.floor(Date.now() / 1000)
  const active = proposals.filter(p => p.account.endTime.toNumber() > now && !p.account.isFinalized)
  const ended = proposals.filter(p => p.account.endTime.toNumber() <= now || p.account.isFinalized)

  const ProposalCard = ({ p }: { p: ProposalAccount }) => {
    const isActive = p.account.endTime.toNumber() > now && !p.account.isFinalized
    const endsIn = p.account.endTime.toNumber() - now
    const days = Math.floor(endsIn / 86400)
    const hours = Math.floor((endsIn % 86400) / 3600)
    const mins = Math.floor((endsIn % 3600) / 60)
    const timeStr = isActive
      ? (days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`)
      : 'Ended'

    return (
      <div className="card proposal-card" onClick={() =>
        navigate(isActive ? `/vote/${p.publicKey.toBase58()}` : `/results/${p.publicKey.toBase58()}`)
      }>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <span className={`badge ${isActive ? 'badge-active' : p.account.isFinalized ? 'badge-final' : 'badge-ended'}`}>
            {p.account.isFinalized ? 'Finalized' : isActive ? 'Active' : 'Ended'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--cream-dim)' }}>
            {isActive ? `⏱ ${timeStr} left` : timeStr}
          </span>
        </div>
        <div className="proposal-title">{p.account.title}</div>
        <div className="proposal-meta">
          <div>Options: {[p.account.option0, p.account.option1, p.account.option2].join(' · ')}…</div>
          <div style={{ marginTop: 4 }}>Min token: {p.account.minTokenAmount.toNumber()}</div>
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          {isActive
            ? <span style={{ fontSize: 13, color: 'var(--gold)' }}>Vote →</span>
            : <span style={{ fontSize: 13, color: 'var(--cream-dim)' }}>View Results →</span>
          }
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <h2 style={{ fontFamily: "'Cinzel',serif", color: 'var(--gold)', marginBottom: 8 }}>Browse Proposals</h2>
      <p style={{ color: 'var(--cream-dim)', marginBottom: 32 }}>All on-chain proposals from Incognito Ballots.</p>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--cream-dim)' }}>
          <span className="spinner" />Loading proposals from Solana devnet…
        </div>
      ) : proposals.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>☂</div>
          <div style={{ color: 'var(--cream-dim)' }}>No proposals yet.</div>
          <button className="btn-primary" style={{ marginTop: 20 }} onClick={() => navigate('/create')}>
            Create the First One
          </button>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <>
              <h3 style={{ fontFamily: "'Cinzel',serif", fontSize: 15, color: 'var(--cream-dim)', letterSpacing: '0.08em', marginBottom: 16 }}>
                ACTIVE PROPOSALS ({active.length})
              </h3>
              <div className="proposals-grid">
                {active.map(p => <ProposalCard key={p.publicKey.toBase58()} p={p} />)}
              </div>
            </>
          )}
          {ended.length > 0 && (
            <>
              <div style={{ marginTop: 40, marginBottom: 16 }}>
                <h3 style={{ fontFamily: "'Cinzel',serif", fontSize: 15, color: 'var(--cream-dim)', letterSpacing: '0.08em' }}>
                  ENDED / FINALIZED ({ended.length})
                </h3>
              </div>
              <div className="proposals-grid">
                {ended.map(p => <ProposalCard key={p.publicKey.toBase58()} p={p} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
