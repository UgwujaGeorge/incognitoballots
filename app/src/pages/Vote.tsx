import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { AnchorProvider, Program, BN, type Idl } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token'
import {
  getArciumProgramId, getMXEAccAddress, getMempoolAccAddress,
  getExecutingPoolAccAddress, getComputationAccAddress, getClusterAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getFeePoolAccAddress,
  getClockAccAddress, getMXEPublicKey,
  awaitComputationFinalization, RescueCipher, deserializeLE, x25519
} from '@arcium-hq/client'
import idl from '../../idl/incognitoballots.json'
import { PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, deriveVoteRecordPDA, getSignPDA } from '../utils/program'

const randomBytes = (n: number): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(n)))

export default function Vote() {
  const { proposal: proposalAddr } = useParams<{ proposal: string }>()
  const { publicKey, signTransaction, signAllTransactions } = useWallet()
  const { connection } = useConnection()
  const navigate = useNavigate()

  const [proposal, setProposal] = useState<any>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [hasVoted, setHasVoted] = useState(false)

  const proposalPDA = proposalAddr ? new PublicKey(proposalAddr) : null

  useEffect(() => {
    if (!proposalPDA || !connection) return
    async function load() {
      try {
        const { Keypair } = await import('@solana/web3.js')
        const dummy = Keypair.generate()
        const provider = new AnchorProvider(connection, { publicKey: dummy.publicKey, signTransaction: async t => t, signAllTransactions: async t => t }, { commitment: 'confirmed' })
        const program = new Program(idl as Idl, provider)
        const acc = await (program.account as any).proposal.fetch(proposalPDA!)
        setProposal(acc)

        if (publicKey) {
          const [vrPDA] = deriveVoteRecordPDA(proposalPDA!, publicKey)
          try {
            const vr = await (program.account as any).voteRecord.fetch(vrPDA)
            if (vr.hasVoted) setHasVoted(true)
          } catch {}
        }
      } catch (e) {
        setError('Failed to load proposal.')
      } finally {
        setFetching(false)
      }
    }
    load()
  }, [proposalAddr, connection, publicKey])

  const castVote = async () => {
    if (!publicKey || !signTransaction || !signAllTransactions || !proposalPDA || selected === null) return
    setLoading(true); setError(''); setSuccess('')
    try {
      const provider = new AnchorProvider(connection, { publicKey, signTransaction, signAllTransactions }, { commitment: 'confirmed' })
      const program = new Program(idl as Idl, provider)

      const mxeAccount = getMXEAccAddress(PROGRAM_ID)

      // Get MXE public key for encryption
      const mxePublicKey = await getMXEPublicKey(provider, PROGRAM_ID)
      if (!mxePublicKey) throw new Error('Could not fetch MXE public key')

      const privateKey = x25519.utils.randomSecretKey()
      const pubKey = x25519.getPublicKey(privateKey)
      const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey)
      const cipher = new RescueCipher(sharedSecret)

      const nonce = randomBytes(16)
      const [voteCiphertext] = cipher.encrypt([BigInt(selected)], nonce)

      const computationOffset = new BN(randomBytes(8), 'hex')
      const [voteRecordPDA] = deriveVoteRecordPDA(proposalPDA, publicKey)
      const signPDA = getSignPDA()

      const voterTokenAccount = await getAssociatedTokenAddress(
        proposal.requiredTokenMint, publicKey
      )

      const castVoteOffset = getCompDefAccOffset('cast_vote')
      const castVoteCompDefPDA = getCompDefAccAddress(PROGRAM_ID, Buffer.from(castVoteOffset).readUInt32LE())
      const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET as any)

      const sig = await program.methods
        .castVote(
          computationOffset,
          Array.from(voteCiphertext) as any,
          Array.from(pubKey) as any,
          new BN(deserializeLE(nonce).toString())
        )
        .accounts({
          voter: publicKey,
          proposal: proposalPDA,
          voteRecord: voteRecordPDA,
          voterTokenAccount,
          signPdaAccount: signPDA,
          mxeAccount,
          mempoolAccount: getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET),
          computationAccount: getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset),
          compDefAccount: castVoteCompDefPDA,
          clusterAccount,
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          arciumProgram: getArciumProgramId(),
        })
        .rpc({ skipPreflight: true, commitment: 'confirmed' })

      setSuccess(`Vote submitted! Tx: ${sig}\nWaiting for MPC to process…`)

      await awaitComputationFinalization(provider, computationOffset, PROGRAM_ID, 'confirmed')
      setSuccess(`✓ Vote encrypted and recorded on-chain! Your ballot is private.`)
      setHasVoted(true)
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (msg.includes('AlreadyVoted')) setError('You have already voted on this proposal.')
      else if (msg.includes('InsufficientTokens')) setError('Insufficient tokens to vote.')
      else if (msg.includes('WrongToken')) setError('Your token does not match the required mint.')
      else if (msg.includes('VotingEnded')) setError('Voting has ended for this proposal.')
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const options = proposal ? [
    proposal.option0, proposal.option1, proposal.option2, proposal.option3, proposal.option4
  ] : []

  const now = Math.floor(Date.now() / 1000)
  const isActive = proposal && proposal.endTime.toNumber() > now

  if (fetching) return (
    <div className="page-container" style={{ textAlign: 'center', paddingTop: 80 }}>
      <span className="spinner" />Loading proposal…
    </div>
  )

  if (!proposal) return (
    <div className="page-container">
      <div className="error-msg">Proposal not found.</div>
    </div>
  )

  return (
    <div className="page-container" style={{ maxWidth: 680 }}>
      <div style={{ marginBottom: 8 }}>
        <span className={`badge ${isActive ? 'badge-active' : 'badge-ended'}`}>
          {isActive ? 'Active' : 'Voting Ended'}
        </span>
        <span className="enc-badge" style={{ marginLeft: 10 }}>☂ Arcium MPC Encrypted</span>
      </div>

      <h2 style={{ fontFamily: "'Cinzel',serif", color: 'var(--gold)', margin: '16px 0 8px' }}>
        {proposal.title}
      </h2>

      <div style={{ color: 'var(--cream-dim)', fontSize: 14, marginBottom: 24 }}>
        Ends: {new Date(proposal.endTime.toNumber() * 1000).toLocaleString()} ·
        Token required: {proposal.requiredTokenMint.toBase58().slice(0, 8)}… ·
        Min: {proposal.minTokenAmount.toNumber()}
      </div>

      <div style={{ background: 'rgba(70,130,200,0.08)', border: '1px solid rgba(70,130,200,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 24, fontSize: 14, color: '#8ab4e8' }}>
        🔐 Your vote is encrypted before it leaves your browser using x25519 + Rescue cipher.
        No one — not even the node operators — can see how you voted.
      </div>

      {hasVoted ? (
        <div style={{ background: 'rgba(112,192,151,0.1)', border: '1px solid rgba(112,192,151,0.3)', borderRadius: 8, padding: '20px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>✓</div>
          <div style={{ fontFamily: "'Cinzel',serif", color: 'var(--success)' }}>You have already voted on this proposal.</div>
          <button className="btn-secondary" style={{ marginTop: 16 }} onClick={() => navigate(`/results/${proposalAddr}`)}>
            View Results Page →
          </button>
        </div>
      ) : !isActive ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ color: 'var(--cream-dim)', marginBottom: 16 }}>Voting has ended.</div>
          <button className="btn-primary" onClick={() => navigate(`/results/${proposalAddr}`)}>
            View Results
          </button>
        </div>
      ) : (
        <>
          <div className="vote-options">
            {options.map((opt: string, i: number) => (
              <div key={i} className={`vote-option${selected === i ? ' selected' : ''}`}
                onClick={() => setSelected(i)}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%',
                  border: `2px solid ${selected === i ? 'var(--gold)' : 'var(--border)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                }}>
                  {selected === i && <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--gold)' }} />}
                </div>
                <span className="vote-option-label">{opt}</span>
              </div>
            ))}
          </div>

          {error && <div className="error-msg">{error}</div>}
          {success && <div className="success-msg" style={{ whiteSpace: 'pre-line' }}>{success}</div>}

          <button
            className="btn-primary"
            disabled={selected === null || loading || !publicKey}
            onClick={castVote}
            style={{ width: '100%', marginTop: 8 }}
          >
            {loading
              ? <><span className="spinner" />Encrypting & submitting vote…</>
              : !publicKey
              ? 'Connect Wallet to Vote'
              : selected === null
              ? 'Select an option'
              : `Cast Encrypted Vote for "${options[selected]}"`
            }
          </button>
        </>
      )}
    </div>
  )
}
