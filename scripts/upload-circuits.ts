/**
 * One-time setup: init comp defs + upload circuits to devnet.
 * Run with: ARCIUM_CLUSTER_OFFSET=456 ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json npx ts-node -p ./tsconfig.json scripts/upload-circuits.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getArciumEnv, getArciumProgramId, getArciumProgram, uploadCircuit,
  getMXEAccAddress, getCompDefAccAddress, getCompDefAccOffset, getLookupTableAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

function readKpJson(path: string): Keypair {
  const file = fs.readFileSync(path);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}

async function sendTx(
  connection: anchor.web3.Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const programId = new PublicKey("78RjobteBhdGBMsbjX1eqTvjWAFnb5PDbUbxEC9mvfec");
  const arciumProgram = getArciumProgram(provider);
  const mxeAccount = getMXEAccAddress(programId);

  const castVoteOffset = getCompDefAccOffset("cast_vote");
  const revealTallyOffset = getCompDefAccOffset("reveal_tally");
  const castVoteCompDefPDA = getCompDefAccAddress(programId, Buffer.from(castVoteOffset).readUInt32LE());
  const revealTallyCompDefPDA = getCompDefAccAddress(programId, Buffer.from(revealTallyOffset).readUInt32LE());

  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(programId, mxeAcc.lutOffsetSlot);

  // --- cast_vote ---
  console.log("\n=== cast_vote comp def ===");
  const cvInfo = await provider.connection.getAccountInfo(castVoteCompDefPDA);
  if (!cvInfo) {
    console.log("Initializing cast_vote comp def...");
    const tx = await arciumProgram.methods
      // @ts-ignore — calling via arciumProgram.methods is not how we call our program's methods
      // We need to use the incognitoballots program here
      .initCastVoteCompDef()
      .accounts({
        payer: owner.publicKey, mxeAccount,
        compDefAccount: castVoteCompDefPDA,
        addressLookupTable: lutAddress,
        lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
        arciumProgram: getArciumProgramId(), systemProgram: SystemProgram.programId,
      }).transaction();
    const sig = await sendTx(provider.connection, tx, [owner]);
    console.log("initCastVoteCompDef sig:", sig);
  } else {
    console.log("cast_vote comp def already exists (", cvInfo.data.length, "bytes)");
  }

  console.log("Uploading cast_vote circuit (chunkSize=5, may take a few minutes)...");
  const castVoteCircuit = fs.readFileSync(`${os.homedir()}/incognitoballots/build/cast_vote.arcis`);
  const cvSigs = await uploadCircuit(provider, "cast_vote", programId, castVoteCircuit, true, 5,
    { skipPreflight: true, commitment: "confirmed" });
  if (cvSigs.length === 0) {
    console.log("cast_vote circuit already uploaded — skipped.");
  } else {
    console.log(`cast_vote circuit uploaded (${cvSigs.length} txs)`);
  }

  // --- reveal_tally ---
  console.log("\n=== reveal_tally comp def ===");
  const rtInfo = await provider.connection.getAccountInfo(revealTallyCompDefPDA);
  if (!rtInfo) {
    console.log("Initializing reveal_tally comp def...");
    const tx = await arciumProgram.methods
      // @ts-ignore
      .initRevealTallyCompDef()
      .accounts({
        payer: owner.publicKey, mxeAccount,
        compDefAccount: revealTallyCompDefPDA,
        addressLookupTable: lutAddress,
        lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
        arciumProgram: getArciumProgramId(), systemProgram: SystemProgram.programId,
      }).transaction();
    const sig = await sendTx(provider.connection, tx, [owner]);
    console.log("initRevealTallyCompDef sig:", sig);
  } else {
    console.log("reveal_tally comp def already exists (", rtInfo.data.length, "bytes)");
  }

  console.log("Uploading reveal_tally circuit (chunkSize=5, may take a few minutes)...");
  const revealTallyCircuit = fs.readFileSync(`${os.homedir()}/incognitoballots/build/reveal_tally.arcis`);
  const rtSigs = await uploadCircuit(provider, "reveal_tally", programId, revealTallyCircuit, true, 5,
    { skipPreflight: true, commitment: "confirmed" });
  if (rtSigs.length === 0) {
    console.log("reveal_tally circuit already uploaded — skipped.");
  } else {
    console.log(`reveal_tally circuit uploaded (${rtSigs.length} txs)`);
  }

  console.log("\n✓ All circuits uploaded. You can now run the main tests (tests 3-6).");
}

main().catch(e => { console.error(e); process.exit(1); });
