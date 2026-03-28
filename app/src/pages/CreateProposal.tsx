import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { AnchorProvider, Program, BN, type Idl } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import {
  getArciumProgramId, getMXEAccAddress, getMempoolAccAddress,
  getExecutingPoolAccAddress, getComputationAccAddress, getClusterAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getFeePoolAccAddress,
  getClockAccAddress, awaitComputationFinalization
} from '@arcium-hq/client'
import idl from '../../idl/incognitoballots.json'
import { PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, deriveProposalPDA, getSignPDA } from '../utils/program'

const randomBytes = (n: number): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(n)))

export default function CreateProposal() {
  const { publicKey, signTransaction, signAllTransactions } = useWallet()
  const { connection } = useConnection()
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [options, setOptions] = useState(['', '', '', '', ''])
  const nowRounded = () => {
    const d = new Date(); d.setSeconds(0, 0); return d
  }
  const toLocalISO = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)

  const [startTime, setStartTime] = useState(() => toLocalISO(nowRounded()))
  const [endTime, setEndTime] = useState(() => {
    const d = nowRounded(); d.setHours(d.getHours() + 1); return toLocalISO(d)
  })
  const [mintAddr, setMintAddr] = useState('')
  const [minAmount, setMinAmount] = useState(1)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const setOption = (i: number, v: string) => {
    const next = [...options]; next[i] = v; setOptions(next)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!publicKey || !signTransaction || !signAllTransactions) {
      setError('Please connect your wallet first.'); return
    }
    if (!title.trim() || options.some(o => !o.trim())) {
      setError('Please fill all fields.'); return
    }
    const startMs = new Date(startTime).getTime()
    const endMs = new Date(endTime).getTime()
    const durationSecs = Math.floor((endMs - startMs) / 1000)
    if (endMs <= startMs) {
      setError('End time must be after start time.'); return
    }
    if (durationSecs < 600) {
      setError('Minimum duration is 10 minutes.'); return
    }
    let mintPubkey: PublicKey
    try { mintPubkey = new PublicKey(mintAddr) }
    catch { setError('Invalid token mint address.'); return }

    setLoading(true); setError(''); setStatus('')
    try {
      const provider = new AnchorProvider(connection, { publicKey, signTransaction, signAllTransactions }, { commitment: 'confirmed' })
      const program = new Program(idl as Idl, provider)
      const [proposalPDA] = deriveProposalPDA(publicKey, title)

      // Step 1: create proposal
      setStatus('Creating proposal on-chain…')
      await program.methods
        .createProposal(
          title,
          options[0], options[1], options[2], options[3], options[4],
          new BN(durationSecs),
          mintPubkey,
          new BN(minAmount)
        )
        .accounts({
          authority: publicKey,
          proposal: proposalPDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: 'confirmed' })

      // Step 2: init encrypted tally via Arcium MPC
      setStatus('Initializing encrypted tally via Arcium MPC… (please approve the second transaction)')
      const mxeAccount = getMXEAccAddress(PROGRAM_ID)
      const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET)
      const computationOffset = new BN(randomBytes(8), 'hex')
      const signPDA = getSignPDA()
      const initTallyOffset = getCompDefAccOffset('init_tally')
      const initTallyCompDefPDA = getCompDefAccAddress(PROGRAM_ID, Buffer.from(initTallyOffset).readUInt32LE())

      await program.methods
        .initTally(computationOffset)
        .accounts({
          authority: publicKey,
          proposal: proposalPDA,
          signPdaAccount: signPDA,
          mxeAccount,
          mempoolAccount: getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET),
          computationAccount: getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset),
          compDefAccount: initTallyCompDefPDA,
          clusterAccount,
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: getArciumProgramId(),
        })
        .rpc({ skipPreflight: true, commitment: 'confirmed' })

      setStatus('Waiting for MPC to initialize the encrypted tally…')
      await awaitComputationFinalization(provider, computationOffset, PROGRAM_ID, 'confirmed')

      setStatus('✓ Proposal ready! Redirecting to browse…')
      setTimeout(() => navigate('/browse'), 1500)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: 640 }}>
      <h2 style={{ fontFamily: "'Cinzel',serif", color: 'var(--gold)', marginBottom: 8 }}>Create Proposal</h2>
      <p style={{ color: 'var(--cream-dim)', marginBottom: 32, fontSize: 15 }}>
        Set up a token-gated private vote. Ballots are encrypted — no one sees the running tally until you reveal it.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label">PROPOSAL TITLE</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Which feature should we build next?" maxLength={100} required />
        </div>

        <div className="form-group">
          <label className="form-label">VOTING OPTIONS (5 required)</label>
          {options.map((opt, i) => (
            <input key={i} style={{ marginBottom: 8 }} value={opt}
              onChange={e => setOption(i, e.target.value)}
              placeholder={`Option ${i + 1}`} maxLength={50} required />
          ))}
        </div>

        <div className="form-group">
          <label className="form-label">START DATE & TIME</label>
          <input type="datetime-local" value={startTime}
            onChange={e => setStartTime(e.target.value)} required />
        </div>

        <div className="form-group">
          <label className="form-label">END DATE & TIME</label>
          <input type="datetime-local" value={endTime}
            onChange={e => setEndTime(e.target.value)} required />
          {startTime && endTime && new Date(endTime) > new Date(startTime) && (
            <div style={{ fontSize: 13, color: 'var(--cream-dim)', marginTop: 5 }}>
              {(() => {
                const secs = Math.floor((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
                const d = Math.floor(secs / 86400)
                const h = Math.floor((secs % 86400) / 3600)
                const m = Math.floor((secs % 3600) / 60)
                return `Duration: ${d > 0 ? `${d}d ` : ''}${h > 0 ? `${h}h ` : ''}${m}m`
              })()}
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">REQUIRED TOKEN MINT ADDRESS</label>
          <input value={mintAddr} onChange={e => setMintAddr(e.target.value)}
            placeholder="e.g. So11111111111111111111111111111111111111112" required />
          <div style={{ fontSize: 13, color: 'var(--cream-dim)', marginTop: 5 }}>
            Only wallets holding this SPL token can vote.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">MINIMUM TOKEN AMOUNT</label>
          <input type="number" value={minAmount} min={1}
            onChange={e => setMinAmount(Number(e.target.value))} required />
        </div>

        {error && <div className="error-msg">{error}</div>}
        {status && <div className="success-msg">{status}</div>}

        <button type="submit" className="btn-primary" disabled={loading || !publicKey}
          style={{ marginTop: 24, width: '100%' }}>
          {loading ? <><span className="spinner" />{status || 'Working…'}</> : !publicKey ? 'Connect Wallet First' : 'Create Proposal'}
        </button>
      </form>
    </div>
  )
}
