import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, mintTo, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Incognitoballots } from "../target/types/incognitoballots";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization, getArciumEnv, getCompDefAccOffset,
  getArciumProgramId, getArciumProgram, uploadCircuit,
  RescueCipher, deserializeLE, getMXEPublicKey, getMXEAccAddress,
  getMempoolAccAddress, getCompDefAccAddress, getExecutingPoolAccAddress,
  getComputationAccAddress, getClusterAccAddress, getLookupTableAddress,
  x25519, getFeePoolAccAddress, getClockAccAddress, claimComputationRent,
  getCircuitState, getRawCircuitAccAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

// Checks if an error is a Solana Custom: 0 (AlreadyInitialized) error.
// The error may be a raw object, an AnchorError, or a SendTransactionError.
function isAlreadyInitialized(err: any): boolean {
  const s = JSON.stringify(err) ?? "";
  if (s.includes('"Custom":0') || s.includes('"Custom": 0')) return true;
  const msg = err?.message ?? err?.toString() ?? "";
  return msg.includes("custom program error: 0x0") || msg.includes("Custom: 0");
}

function readKpJson(path: string): Keypair {
  const file = fs.readFileSync(path);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}

// Sign PDA: derived from SIGN_PDA_SEED = b"ArciumSignerAccount" and OUR program ID (not Arcium's)
function getSignPDA(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("ArciumSignerAccount")], programId)[0];
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider, programId: PublicKey,
  maxRetries = 20, retryDelayMs = 1000
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (e) { console.log(`Attempt ${attempt} failed:`, e); }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, retryDelayMs));
  }
  throw new Error("Failed to fetch MXE public key");
}

// Send a transaction manually without going through Anchor's sendAndConfirm
// (which has a bug with web3.js SendTransactionError "Unknown action 'undefined'")
async function sendTx(
  connection: anchor.web3.Connection,
  tx: Transaction,
  signers: Keypair[],
  opts: { skipPreflight?: boolean; commitment?: anchor.web3.Commitment } = {}
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const rawTx = tx.serialize();
  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight: opts.skipPreflight ?? true,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    opts.commitment ?? "confirmed"
  );
  return sig;
}

const RAW_CIRCUIT_ACCOUNT_HEADER_SIZE = 9; // 8-byte discriminator + 1-byte bump
const MAX_RAW_CIRCUIT_ACCOUNT_SIZE = 10 * 1024 * 1024;
const MAX_RAW_UPLOAD_BYTES_PER_TX = 814;
const MAX_RAW_REALLOC_BYTES_PER_IX = 10_240;
const MAX_RAW_EMBIGGEN_IX_PER_TX = 18;

async function uploadCircuitChecked(
  provider: anchor.AnchorProvider,
  circuitName: string,
  mxeProgramId: PublicKey,
  rawCircuit: Uint8Array,
  owner: Keypair,
): Promise<string[]> {
  const arciumProgram = getArciumProgram(provider);
  const compDefOffsetBytes = getCompDefAccOffset(circuitName);
  const compDefOffset = Buffer.from(compDefOffsetBytes).readUInt32LE();
  const compDefPubkey = getCompDefAccAddress(mxeProgramId, compDefOffset);
  const compDefAcc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
  const state = getCircuitState(compDefAcc.circuitSource as any);
  if (state !== "OnchainPending") {
    console.log(`Circuit ${circuitName} skipped: ${state}`);
    return [];
  }

  const rawChunkCapacity = MAX_RAW_CIRCUIT_ACCOUNT_SIZE - RAW_CIRCUIT_ACCOUNT_HEADER_SIZE;
  const partCount = Math.ceil(rawCircuit.length / rawChunkCapacity);
  const sigs: string[] = [];

  for (let rawCircuitIndex = 0; rawCircuitIndex < partCount; rawCircuitIndex++) {
    const rawCircuitPart = rawCircuit.subarray(
      rawCircuitIndex * rawChunkCapacity,
      Math.min((rawCircuitIndex + 1) * rawChunkCapacity, rawCircuit.length),
    );
    const rawCircuitPda = getRawCircuitAccAddress(compDefPubkey, rawCircuitIndex);
    let existingAcc = await provider.connection.getAccountInfo(rawCircuitPda, "confirmed");

    if (existingAcc === null) {
      const initTx = await arciumProgram.methods
        .initRawCircuitAcc(compDefOffset, mxeProgramId, rawCircuitIndex)
        .accounts({ signer: owner.publicKey })
        .transaction();
      sigs.push(await sendTx(provider.connection, initTx, [owner], { commitment: "confirmed" }));
      existingAcc = await provider.connection.getAccountInfo(rawCircuitPda, "confirmed");
    }

    const requiredSize = RAW_CIRCUIT_ACCOUNT_HEADER_SIZE + rawCircuitPart.length;
    while ((existingAcc?.data.length ?? 0) < requiredSize) {
      const currentPayloadSize = Math.max((existingAcc?.data.length ?? RAW_CIRCUIT_ACCOUNT_HEADER_SIZE) - RAW_CIRCUIT_ACCOUNT_HEADER_SIZE, 0);
      const resizeRemaining = rawCircuitPart.length - currentPayloadSize;
      const ixCount = Math.ceil(
        Math.min(resizeRemaining, MAX_RAW_REALLOC_BYTES_PER_IX * MAX_RAW_EMBIGGEN_IX_PER_TX)
        / MAX_RAW_REALLOC_BYTES_PER_IX
      );
      const resizeTx = new Transaction();
      for (let i = 0; i < ixCount; i++) {
        resizeTx.add(await arciumProgram.methods
          .embiggenRawCircuitAcc(compDefOffset, mxeProgramId, rawCircuitIndex)
          .accounts({ signer: owner.publicKey })
          .instruction());
      }
      sigs.push(await sendTx(provider.connection, resizeTx, [owner], { commitment: "confirmed" }));
      existingAcc = await provider.connection.getAccountInfo(rawCircuitPda, "confirmed");
    }

    const onchainBytes = existingAcc!.data.subarray(
      RAW_CIRCUIT_ACCOUNT_HEADER_SIZE,
      RAW_CIRCUIT_ACCOUNT_HEADER_SIZE + rawCircuitPart.length
    );
    if (Buffer.compare(Buffer.from(onchainBytes), Buffer.from(rawCircuitPart)) === 0) {
      console.log(`Raw circuit acc ${rawCircuitIndex} already matches local bytes, skipping`);
      continue;
    }

    const uploadTxCount = Math.ceil(rawCircuitPart.length / MAX_RAW_UPLOAD_BYTES_PER_TX);
    for (let uploadTxIndex = 0; uploadTxIndex < uploadTxCount; uploadTxIndex++) {
      const circuitOffset = uploadTxIndex * MAX_RAW_UPLOAD_BYTES_PER_TX;
      const chunk = rawCircuitPart.subarray(
        circuitOffset,
        Math.min(circuitOffset + MAX_RAW_UPLOAD_BYTES_PER_TX, rawCircuitPart.length)
      );
      const paddedChunk = Buffer.alloc(MAX_RAW_UPLOAD_BYTES_PER_TX);
      paddedChunk.set(chunk);
      const uploadTx = await arciumProgram.methods
        .uploadCircuit(
          compDefOffset,
          mxeProgramId,
          rawCircuitIndex,
          Array.from(paddedChunk),
          circuitOffset,
        )
        .accounts({ signer: owner.publicKey })
        .transaction();
      sigs.push(await sendTx(provider.connection, uploadTx, [owner], { commitment: "confirmed" }));
    }
  }

  const finalizeTx = await arciumProgram.methods
    .finalizeComputationDefinition(compDefOffset, mxeProgramId)
    .accounts({ signer: owner.publicKey })
    .transaction();
  sigs.push(await sendTx(provider.connection, finalizeTx, [owner], { commitment: "confirmed" }));

  return sigs;
}

describe("Incognito Ballots – full devnet test", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Incognitoballots as Program<Incognitoballots>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const mxeAccount = getMXEAccAddress(program.programId);

  const castVoteOffset = getCompDefAccOffset("cast_vote");
  const revealTallyOffset = getCompDefAccOffset("reveal_tally");
  const initTallyOffset = getCompDefAccOffset("init_tally");
  const fetchTallyOffset = getCompDefAccOffset("fetch_tally");
  const castVoteCompDefPDA = getCompDefAccAddress(program.programId, Buffer.from(castVoteOffset).readUInt32LE());
  const revealTallyCompDefPDA = getCompDefAccAddress(program.programId, Buffer.from(revealTallyOffset).readUInt32LE());
  const initTallyCompDefPDA = getCompDefAccAddress(program.programId, Buffer.from(initTallyOffset).readUInt32LE());
  const fetchTallyCompDefPDA = getCompDefAccAddress(program.programId, Buffer.from(fetchTallyOffset).readUInt32LE());

  let mintPubkey: PublicKey;
  let voterTokenAccount: PublicKey;
  let proposalPDA: PublicKey;
  // Title must be ≤32 bytes (Solana PDA seed limit). Use last 7 digits of timestamp for uniqueness.
  const proposalTitle = `Best MPC? ${Date.now() % 10000000}`;

  it("1. Init cast_vote computation definition", async () => {
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
    // Init comp def — idempotent (skip if already initialized)
    try {
      const tx = await program.methods.initCastVoteCompDef()
        .accounts({
          payer: owner.publicKey, mxeAccount,
          compDefAccount: castVoteCompDefPDA,
          addressLookupTable: lutAddress,
          lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
          arciumProgram: getArciumProgramId(), systemProgram: SystemProgram.programId,
        }).transaction();
      const sig = await sendTx(provider.connection, tx, [owner]);
      console.log("initCastVoteCompDef sig:", sig);
    } catch (err: any) {
      if (isAlreadyInitialized(err)) {
        console.log("initCastVoteCompDef already initialized — skipping init, still uploading circuit.");
      } else {
        throw err;
      }
    }
    // Upload circuit — uploadCircuit is idempotent (skips if state !== OnchainPending)
    const circuitBinary = fs.readFileSync(`${os.homedir()}/incognitoballots/build/cast_vote.arcis`);
    const sigs = await uploadCircuitChecked(provider, "cast_vote", program.programId, circuitBinary, owner);
    console.log(sigs.length > 0 ? `cast_vote circuit uploaded (${sigs.length} txs)` : "cast_vote circuit already uploaded — skipped.");
  });

  it("2. Init reveal_tally computation definition", async () => {
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
    // Init comp def — idempotent
    try {
      const tx = await program.methods.initRevealTallyCompDef()
        .accounts({
          payer: owner.publicKey, mxeAccount,
          compDefAccount: revealTallyCompDefPDA,
          addressLookupTable: lutAddress,
          lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
          arciumProgram: getArciumProgramId(), systemProgram: SystemProgram.programId,
        }).transaction();
      const sig = await sendTx(provider.connection, tx, [owner]);
      console.log("initRevealTallyCompDef sig:", sig);
    } catch (err: any) {
      if (isAlreadyInitialized(err)) {
        console.log("initRevealTallyCompDef already initialized — skipping init, still uploading circuit.");
      } else {
        throw err;
      }
    }
    // Upload circuit — idempotent
    const circuitBinary = fs.readFileSync(`${os.homedir()}/incognitoballots/build/reveal_tally.arcis`);
    const sigs = await uploadCircuitChecked(provider, "reveal_tally", program.programId, circuitBinary, owner);
    console.log(sigs.length > 0 ? `reveal_tally circuit uploaded (${sigs.length} txs)` : "reveal_tally circuit already uploaded — skipped.");
  });

  it("3. Init init_tally computation definition", async () => {
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
    try {
      const tx = await program.methods.initInitTallyCompDef()
        .accounts({
          payer: owner.publicKey, mxeAccount,
          compDefAccount: initTallyCompDefPDA,
          addressLookupTable: lutAddress,
          lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
          arciumProgram: getArciumProgramId(), systemProgram: SystemProgram.programId,
        }).transaction();
      const sig = await sendTx(provider.connection, tx, [owner]);
      console.log("initInitTallyCompDef sig:", sig);
    } catch (err: any) {
      if (isAlreadyInitialized(err)) {
        console.log("initInitTallyCompDef already initialized — skipping init, still uploading circuit.");
      } else {
        throw err;
      }
    }
    const circuitBinary = fs.readFileSync(`${os.homedir()}/incognitoballots/build/init_tally.arcis`);
    const sigs = await uploadCircuitChecked(provider, "init_tally", program.programId, circuitBinary, owner);
    console.log(sigs.length > 0 ? `init_tally circuit uploaded (${sigs.length} txs)` : "init_tally circuit already uploaded — skipped.");
  });

  it("3b. Init fetch_tally computation definition", async () => {
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
    try {
      const tx = await program.methods.initFetchTallyCompDef()
        .accounts({
          payer: owner.publicKey, mxeAccount,
          compDefAccount: fetchTallyCompDefPDA,
          addressLookupTable: lutAddress,
          lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
          arciumProgram: getArciumProgramId(), systemProgram: SystemProgram.programId,
        }).transaction();
      const sig = await sendTx(provider.connection, tx, [owner]);
      console.log("initFetchTallyCompDef sig:", sig);
    } catch (err: any) {
      if (isAlreadyInitialized(err)) {
        console.log("initFetchTallyCompDef already initialized — skipping init, still uploading circuit.");
      } else {
        throw err;
      }
    }
    const circuitBinary = fs.readFileSync(`${os.homedir()}/incognitoballots/build/fetch_tally.arcis`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const sigs = await uploadCircuitChecked(provider, "fetch_tally", program.programId, circuitBinary, owner);
        console.log(sigs.length > 0 ? `fetch_tally circuit uploaded (${sigs.length} txs)` : "fetch_tally circuit already uploaded — skipped.");
        break;
      } catch (uploadErr: any) {
        if (attempt < 5) {
          console.log(`Circuit upload attempt ${attempt} failed, retrying in 5s: ${uploadErr?.message ?? uploadErr}`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          throw uploadErr;
        }
      }
    }
  });

  it("4. Create SPL token mint and fund voter", async () => {
    mintPubkey = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    console.log("Mint:", mintPubkey.toBase58());
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection, owner, mintPubkey, owner.publicKey);
    voterTokenAccount = ata.address;
    await mintTo(provider.connection, owner, mintPubkey, voterTokenAccount, owner, 10);
    console.log("Minted 10 tokens:", voterTokenAccount.toBase58());
  });

  it("5. Create a proposal", async () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), owner.publicKey.toBuffer(), Buffer.from(proposalTitle)],
      program.programId
    );
    proposalPDA = pda;
    const tx = await program.methods
      .createProposal(proposalTitle, "Arcium", "Aztec", "Zama", "Penumbra", "Other",
        new BN(600), mintPubkey, new BN(1))
      .accounts({ authority: owner.publicKey, proposal: proposalPDA, systemProgram: SystemProgram.programId })
      .transaction();
    const sig = await sendTx(provider.connection, tx, [owner]);
    console.log("createProposal sig:", sig);
    console.log("Proposal:", proposalPDA.toBase58());
  });

  it("6. Initialize encrypted tally via MPC (init_tally)", async () => {
    const computationOffset = new BN(randomBytes(8), "hex");
    const signPDA = getSignPDA(program.programId);
    const tx = await program.methods.initTally(computationOffset)
      .accounts({
        authority: owner.publicKey, proposal: proposalPDA, signPdaAccount: signPDA, mxeAccount,
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
        compDefAccount: initTallyCompDefPDA, clusterAccount,
        poolAccount: getFeePoolAccAddress(), clockAccount: getClockAccAddress(),
        systemProgram: SystemProgram.programId, arciumProgram: getArciumProgramId(),
      })
      .transaction();
    const sig = await sendTx(provider.connection, tx, [owner]);
    console.log("initTally queued:", sig);
    const finalizeSig = await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");
    console.log("MPC initTally finalized:", finalizeSig);
    const proposal = await (program.account as any).proposal.fetch(proposalPDA);
    const nonzeroNonce = proposal.tallyNonce.some((b: number) => b !== 0);
    expect(nonzeroNonce).to.be.true;
    console.log("✓ Encrypted tally initialized on-chain");
  });

  it("7. Cast encrypted vote (option 0 = Arcium)", async () => {
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const privateKey = x25519.utils.randomSecretKey();
    const pubKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = randomBytes(16);
    const [voteCiphertext] = cipher.encrypt([BigInt(0)], nonce);
    const computationOffset = new BN(randomBytes(8), "hex");
    const [voteRecordPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote_record"), proposalPDA.toBuffer(), owner.publicKey.toBuffer()],
      program.programId
    );
    const signPDA = getSignPDA(program.programId);
    const tx = await program.methods
      .castVote(
        computationOffset,
        Array.from(voteCiphertext) as any,
        Array.from(pubKey) as any,
        new BN(deserializeLE(nonce).toString())
      )
      .accounts({
        voter: owner.publicKey, proposal: proposalPDA, voteRecord: voteRecordPDA,
        voterTokenAccount, signPdaAccount: signPDA, mxeAccount,
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
        compDefAccount: castVoteCompDefPDA, clusterAccount,
        poolAccount: getFeePoolAccAddress(), clockAccount: getClockAccAddress(),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        arciumProgram: getArciumProgramId(),
      })
      .transaction();
    const sig = await sendTx(provider.connection, tx, [owner]);
    console.log("castVote sig:", sig);
    const finalizeSig = await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");
    console.log("MPC castVote finalized:", finalizeSig);
    const proposal = await (program.account as any).proposal.fetch(proposalPDA);
    const hasData = proposal.encryptedTally.some((ct: number[]) => ct.some((b: number) => b !== 0));
    expect(hasData).to.be.true;
    console.log("✓ Encrypted tally updated on-chain");
  });

  it("8. Fetch tally (falls back to reveal_tally if devnet aborts shared re-encryption)", async () => {
    // Wait until voting period ends
    const proposalData = await (program.account as any).proposal.fetch(proposalPDA);
    const endTime: number = proposalData.endTime.toNumber();
    const nowSecs = Math.floor(Date.now() / 1000);
    const remaining = endTime - nowSecs;
    if (remaining > 0) {
      console.log(`Waiting ${remaining}s for voting period to end…`);
      await new Promise(r => setTimeout(r, (remaining + 15) * 1000));
      console.log("Voting period ended. Proceeding with fetch_tally…");
    }

    // Generate a fresh x25519 keypair + nonce + dummy ciphertexts for the requester
    const requesterPrivKey = x25519.utils.randomSecretKey();
    const requesterPubKey = x25519.getPublicKey(requesterPrivKey);
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const sharedSecret = x25519.getSharedSecret(requesterPrivKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    const inputNonceBytes = randomBytes(16);
    const inputNonceU128 = new BN(deserializeLE(inputNonceBytes).toString());
    // Encrypt dummy zeros to produce valid-shaped ciphertexts (circuit ignores these values)
    const dummyCiphertexts = cipher.encrypt([0n, 0n, 0n, 0n, 0n], inputNonceBytes);

    const MAX_ATTEMPTS = 3;
    let proposal: any = null;
    let successOffset: BN | null = null;
    let fetchFailed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const computationOffset = new BN(randomBytes(8), "hex");
      const signPDA = getSignPDA(program.programId);
      const tx = await program.methods.fetchTally(
        computationOffset,
        Array.from(requesterPubKey) as any,
        inputNonceU128,
        dummyCiphertexts.map(ct => Array.from(ct)) as any,
      )
        .accounts({
          authority: owner.publicKey, proposal: proposalPDA, signPdaAccount: signPDA, mxeAccount,
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
          computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
          compDefAccount: fetchTallyCompDefPDA, clusterAccount,
          poolAccount: getFeePoolAccAddress(), clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId, arciumProgram: getArciumProgramId(),
        })
        .transaction();
      const sig = await sendTx(provider.connection, tx, [owner]);
      console.log(`fetchTally queued (attempt ${attempt}):`, sig);
      const finalizeSig = await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed", 300_000);
      console.log(`MPC fetchTally finalized (attempt ${attempt}):`, finalizeSig);

      proposal = await (program.account as any).proposal.fetch(proposalPDA);
      if (proposal.isFinalized) {
        successOffset = computationOffset;
        break;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.log(`Attempt ${attempt} — MPC returned Failure, retrying…`);
      } else {
        fetchFailed = true;
      }
    }

    if (fetchFailed) {
      console.log(`fetch_tally MPC computation failed after ${MAX_ATTEMPTS} attempts; falling back to reveal_tally.`);
      const computationOffset = new BN(randomBytes(8), "hex");
      const signPDA = getSignPDA(program.programId);
      const tx = await program.methods.revealTally(computationOffset)
        .accounts({
          authority: owner.publicKey, proposal: proposalPDA, signPdaAccount: signPDA, mxeAccount,
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
          computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
          compDefAccount: revealTallyCompDefPDA, clusterAccount,
          poolAccount: getFeePoolAccAddress(), clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId, arciumProgram: getArciumProgramId(),
        })
        .transaction();
      const sig = await sendTx(provider.connection, tx, [owner]);
      console.log("revealTally queued:", sig);
      const finalizeSig = await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed", 300_000);
      console.log("MPC revealTally finalized:", finalizeSig);

      proposal = await (program.account as any).proposal.fetch(proposalPDA);
      expect(proposal.isFinalized).to.be.true;
      expect(Number(proposal.finalTally[0])).to.equal(1);
      console.log("✓ FINAL TALLY REVEALED (on-chain fallback via reveal_tally):");
      console.log("  Option 0 (Arcium)  :", Number(proposal.finalTally[0]));
      console.log("  Option 1 (Aztec)   :", Number(proposal.finalTally[1]));
      console.log("  Option 2 (Zama)    :", Number(proposal.finalTally[2]));
      console.log("  Option 3 (Penumbra):", Number(proposal.finalTally[3]));
      console.log("  Option 4 (Other)   :", Number(proposal.finalTally[4]));
      return;
    }

    // Reclaim the computation deposit
    try {
      const rentSig = await claimComputationRent(
        provider, arciumEnv.arciumClusterOffset, successOffset!,
        { skipPreflight: true, commitment: "confirmed" }
      );
      console.log("claimComputationRent:", rentSig);
    } catch (e: any) {
      console.log("claimComputationRent skipped:", e?.message ?? e);
    }

    // Decrypt the stored encrypted tally client-side using ECDH shared secret
    const nonceBytes = Uint8Array.from(proposal.sharedTallyNonce);
    const ciphertexts: number[][] = proposal.sharedTallyData.map((ct: number[]) => ct);
    const decrypted = cipher.decrypt(ciphertexts, nonceBytes);

    const tally = decrypted.map((v: bigint) => Number(v));
    console.log("✓ FINAL TALLY REVEALED (client-side decryption via fetch_tally):");
    console.log("  Option 0 (Arcium)  :", tally[0]);
    console.log("  Option 1 (Aztec)   :", tally[1]);
    console.log("  Option 2 (Zama)    :", tally[2]);
    console.log("  Option 3 (Penumbra):", tally[3]);
    console.log("  Option 4 (Other)   :", tally[4]);
    expect(proposal.isFinalized).to.be.true;
    expect(tally[0]).to.equal(1); // 1 vote for option 0
  });
});
