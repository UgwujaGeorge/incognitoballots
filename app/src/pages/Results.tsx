import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { AnchorProvider, Program, BN, type Idl } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram, Keypair } from '@solana/web3.js'
import {
  getArciumProgramId, getMXEAccAddress, getMempoolAccAddress,
  getExecutingPoolAccAddress, getComputationAccAddress, getClusterAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getFeePoolAccAddress,
  getClockAccAddress, awaitComputationFinalization
} from '@arcium-hq/client'
import idl from '../../idl/incognitoballots.json'
import { PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, getSignPDA } from '../utils/program'

const randomBytes = (n: number): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(n)))

export default function Results() {
  const { proposal: proposalAddr } = useParams<{ proposal: string }>()
  const { publicKey, signTransaction, signAllTransactions } = useWallet()
  const { connection } = useConnection()

  const [proposal, setProposal] = useState<any>(null)
  const [fetching, setFetching] = useState(true)
  const [revealing, setRevealing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const proposalPDA = proposalAddr ? new PublicKey(proposalAddr) : null

  const loadProposal = async () => {
    if (!proposalPDA || !connection) return
    try {
      const dummy = Keypair.generate()
      const provider = new AnchorProvider(connection, { publicKey: dummy.publicKey, signTransaction: async t => t, signAllTransactions: async t => t }, { commitment: 'confirmed' })
      const program = new Program(idl as Idl, provider)
      const acc = await (program.account as any).proposal.fetch(proposalPDA)
      setProposal(acc)
    } catch {
      setError('Failed to load proposal.')
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => { loadProposal() }, [proposalAddr, connection])

  const revealTally = async () => {
    if (!publicKey || !signTransaction || !signAllTransactions || !proposalPDA) return
    setRevealing(true); setError(''); setSuccess('')
    try {
      const provider = new AnchorProvider(connection, { publicKey, signTransaction, signAllTransactions }, { commitment: 'confirmed' })
      const program = new Program(idl as Idl, provider)

      const mxeAccount = getMXEAccAddress(PROGRAM_ID)
      const computationOffset = new BN(randomBytes(8), 'hex')
      const signPDA = getSignPDA()

      const revealOffset = getCompDefAccOffset('reveal_tally')
      const revealCompDefPDA = getCompDefAccAddress(PROGRAM_ID, Buffer.from(revealOffset).readUInt32LE())
      const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET)

      const sig = await program.methods
        .revealTally(computationOffset)
        .accounts({
          authority: publicKey,
          proposal: proposalPDA,
          signPdaAccount: signPDA,
          mxeAccount,
          mempoolAccount: getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET),
          computationAccount: getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset),
          compDefAccount: revealCompDefPDA,
          clusterAccount,
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: getArciumProgramId(),
        })
        .rpc({ skipPreflight: true, commitment: 'confirmed' })

      setSuccess(`Reveal queued (${sig})\nWaiting for MPC to decrypt…`)
      await awaitComputationFinalization(provider, computationOffset, PROGRAM_ID, 'confirmed')
      setSuccess('✓ Tally revealed! Refreshing…')
      await loadProposal()
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (msg.includes('VotingNotEnded')) setError('Voting has not ended yet. Please wait until the proposal expires.')
      else if (msg.includes('AlreadyFinalized')) setError('This tally has already been revealed.')
      else setError(msg)
    } finally {
      setRevealing(false)
    }
  }

  const options = proposal ? [
    proposal.option0, proposal.option1, proposal.option2, proposal.option3, proposal.option4
  ] : []

  const tally = proposal?.finalTally?.map((n: BN) => n.toNumber()) ?? [0,0,0,0,0]
  const total = tally.reduce((a: number, b: number) => a + b, 0)
  const now = Math.floor(Date.now() / 1000)
  const isEnded = proposal && proposal.endTime.toNumber() <= now

  if (fetching) return (
    <div className="page-container" style={{ textAlign: 'center', paddingTop: 80 }}>
      <span className="spinner" />Loading results…
    </div>
  )

  if (!proposal) return (
    <div className="page-container"><div className="error-msg">Proposal not found.</div></div>
  )

  return (
    <div className="page-container" style={{ maxWidth: 680 }}>
      <div style={{ marginBottom: 8 }}>
        <span className={`badge ${proposal.isFinalized ? 'badge-final' : isEnded ? 'badge-ended' : 'badge-active'}`}>
          {proposal.isFinalized ? 'Finalized' : isEnded ? 'Ended – Awaiting Reveal' : 'Still Active'}
        </span>
      </div>

      <h2 style={{ fontFamily: "'Cinzel',serif", color: 'var(--gold)', margin: '16px 0 8px' }}>
        {proposal.title}
      </h2>

      <div style={{ color: 'var(--cream-dim)', fontSize: 14, marginBottom: 32 }}>
        Ended: {new Date(proposal.endTime.toNumber() * 1000).toLocaleString()}
        {total > 0 && ` · ${total} vote${total !== 1 ? 's' : ''} total`}
      </div>

      {proposal.isFinalized ? (
        <>
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontFamily: "'Cinzel',serif", fontSize: 13, color: 'var(--cream-dim)', letterSpacing: '0.08em', marginBottom: 16 }}>
              FINAL RESULTS — DECRYPTED BY ARCIUM MPC
            </div>
            {options.map((opt: string, i: number) => {
              const votes = tally[i]
              const pct = total > 0 ? Math.round((votes / total) * 100) : 0
              const isWinner = votes === Math.max(...tally) && total > 0
              return (
                <div key={i} className="tally-bar-container">
                  <div className="tally-bar-label">
                    <span style={{ color: isWinner ? 'var(--gold-light)' : 'var(--cream)' }}>
                      {isWinner && '🏆 '}{opt}
                    </span>
                    <span style={{ color: 'var(--cream-dim)' }}>{votes} vote{votes !== 1 ? 's' : ''} ({pct}%)</span>
                  </div>
                  <div className="tally-bar-track">
                    <div className="tally-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>

          <div style={{ background: 'rgba(112,192,151,0.08)', border: '1px solid rgba(112,192,151,0.2)', borderRadius: 8, padding: '14px 18px', fontSize: 14, color: '#8ad4b0' }}>
            ✓ These results were computed privately by Arcium's MPC network.
            No individual votes were revealed during computation.
          </div>
        </>
      ) : isEnded ? (
        <>
          <div style={{
            background: 'rgba(212,168,83,0.08)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 28,
            textAlign: 'center',
            marginBottom: 24
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🔐</div>
            <div style={{ fontFamily: "'Cinzel',serif", color: 'var(--gold)', marginBottom: 8 }}>
              Tally Locked in Encryption
            </div>
            <div style={{ color: 'var(--cream-dim)', fontSize: 15, lineHeight: 1.6 }}>
              Voting has ended. The encrypted tally is stored on-chain.
              Trigger the Arcium MPC reveal to decrypt the final vote counts.
            </div>
          </div>

          {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
          {success && <div className="success-msg" style={{ whiteSpace: 'pre-line', marginBottom: 12 }}>{success}</div>}

          <button
            className="btn-primary"
            onClick={revealTally}
            disabled={revealing || !publicKey}
            style={{ width: '100%' }}
          >
            {revealing
              ? <><span className="spinner" />Requesting MPC Reveal…</>
              : !publicKey
              ? 'Connect Wallet to Reveal'
              : '☂ Reveal Votes via Arcium MPC'
            }
          </button>
          {!publicKey && (
            <div style={{ textAlign: 'center', color: 'var(--cream-dim)', fontSize: 14, marginTop: 10 }}>
              Connect your wallet to trigger the reveal.
            </div>
          )}
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--cream-dim)' }}>
          Voting is still in progress. Results will be available after the proposal ends.
        </div>
      )}
    </div>
  )
}
